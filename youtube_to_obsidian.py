#!/usr/bin/env python3
"""Create an Obsidian transcript or export review audio from YouTube/Bilibili.

Transcript mode downloads captions only. Audio mode downloads the source audio
and converts the selected learning segment locally. Neither mode calls an AI.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from datetime import date
from pathlib import Path
from typing import Iterable


DEFAULT_VAULT = Path.home() / "Documents" / "Obsidian Vault"
DEFAULT_FOLDER = "视频精听"
ENGLISH_LANGUAGE = re.compile(r"^en(?:[-_].*)?$", re.IGNORECASE)
TIMESTAMP = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s+-->"
)
TAG = re.compile(r"<[^>]+>")
WORD = re.compile(r"[\w]+(?:['’][\w]+)*", re.UNICODE)
WINDOWS_RESERVED = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
BILIBILI_BVID = re.compile(r"(?:^|/)video/(BV[0-9A-Za-z]+)", re.IGNORECASE)


# Double-clicking a .cmd file can leave Windows on a legacy console encoding.
# Keep the status messages readable without affecting the UTF-8 note itself.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def fail(message: str) -> "None":
    print(f"\n错误：{message}", file=sys.stderr)
    raise SystemExit(1)


def seconds_from_timestamp(value: str) -> float:
    value = value.replace(",", ".")
    pieces = value.split(":")
    if len(pieces) == 2:
        minutes, seconds = pieces
        return int(minutes) * 60 + float(seconds)
    hours, minutes, seconds = pieces
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def display_timestamp(seconds: float) -> str:
    tenths = int(round(max(0, seconds) * 10))
    whole_seconds, decimal = divmod(tenths, 10)
    hours, remainder = divmod(whole_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    label = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{label}.{decimal}" if decimal else label


def parse_user_timestamp(value: str) -> int:
    pieces = value.strip().split(":")
    if not pieces or any(not piece.isdigit() for piece in pieces) or len(pieces) > 3:
        raise argparse.ArgumentTypeError("时间应写成 SS、MM:SS 或 HH:MM:SS")
    numbers = [int(piece) for piece in pieces]
    if len(numbers) == 1:
        return numbers[0]
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]


def clean_caption(text: str) -> str:
    text = html.unescape(TAG.sub("", text))
    return re.sub(r"\s+", " ", text).strip()


def parse_vtt(path: Path) -> list[tuple[float, str]]:
    """Return non-duplicated caption cues as (start_seconds, text)."""
    cues: list[tuple[int, str]] = []
    lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    index = 0
    while index < len(lines):
        match = TIMESTAMP.search(lines[index])
        if not match:
            index += 1
            continue

        start = seconds_from_timestamp(match.group("start"))
        index += 1
        caption_lines: list[str] = []
        while index < len(lines) and lines[index].strip():
            caption_lines.append(lines[index])
            index += 1
        text = clean_caption(" ".join(caption_lines))
        if not text:
            continue

        # Auto-captions often repeat the same rolling text across adjacent cues.
        if cues and text == cues[-1][1]:
            continue
        if cues and text.startswith(cues[-1][1] + " "):
            cues[-1] = (cues[-1][0], text)
            continue
        cues.append((start, text))
    return cues


def parse_json3(path: Path) -> tuple[list[tuple[float, str]], list[tuple[float, str]]]:
    """Return JSON3 caption cues plus the finer word/fragment timings."""
    payload = json.loads(path.read_text(encoding="utf-8-sig", errors="replace"))
    cues: list[tuple[float, str]] = []
    timed_words: list[tuple[float, str]] = []
    for event in payload.get("events") or []:
        segments = event.get("segs") or []
        text = clean_caption("".join(str(segment.get("utf8") or "") for segment in segments))
        if not text:
            continue
        start = round(int(event.get("tStartMs") or 0) / 1000, 3)
        cues.append((start, text))
        has_offsets = any("tOffsetMs" in segment for segment in segments)
        if has_offsets:
            for segment in segments:
                fragment = clean_caption(str(segment.get("utf8") or ""))
                if not fragment:
                    continue
                offset = int(segment.get("tOffsetMs") or 0) / 1000
                word_start = round(start + offset, 3)
                timed_words.extend((word_start, match.group(0)) for match in WORD.finditer(fragment))
        else:
            # Human-authored tracks commonly provide one 5-8 second cue with
            # no word offsets, even when sentence boundaries fall inside it.
            # Spread words across that cue as a last-resort local estimate.
            words = [match.group(0) for match in WORD.finditer(text)]
            duration = max(0, int(event.get("dDurationMs") or 0) / 1000)
            divisor = max(1, len(words))
            timed_words.extend(
                (round(start + duration * index / divisor, 3), word)
                for index, word in enumerate(words)
            )
    return cues, timed_words


def parse_subtitle(path: Path) -> tuple[list[tuple[float, str]], list[tuple[float, str]]]:
    if path.suffix.lower() == ".json3":
        return parse_json3(path)
    return parse_vtt(path), []


def trim_caption_overlap(previous: str, text: str) -> str:
    if not previous:
        return text

    combined_tokens = previous.split()
    incoming_tokens = text.split()

    def comparable(tokens: list[str]) -> list[tuple[int, str]]:
        result: list[tuple[int, str]] = []
        for index, token in enumerate(tokens):
            key = re.sub(r"[^\w']+", "", token, flags=re.UNICODE).casefold()
            if key:
                result.append((index, key))
        return result

    previous_words = comparable(combined_tokens)
    incoming_words = comparable(incoming_tokens)
    previous_keys = [key for _, key in previous_words]
    incoming_keys = [key for _, key in incoming_words]

    # YouTube rolling captions repeat the end of one cue at the beginning of
    # the next. Keep the original spelling/punctuation, but append only words
    # that were not already present in that overlap.
    maximum = min(len(previous_keys), len(incoming_keys))
    overlap = 0
    for size in range(maximum, 2, -1):
        if previous_keys[-size:] == incoming_keys[:size]:
            overlap = size
            break

    if overlap:
        if overlap == len(incoming_words):
            return ""
        raw_cutoff = incoming_words[overlap - 1][0] + 1
        return " ".join(incoming_tokens[raw_cutoff:]).strip()

    return text


def unique_append(parts: list[str], text: str) -> None:
    if not parts:
        parts.append(text)
        return

    text = trim_caption_overlap(" ".join(parts), text)
    if not text:
        return

    if text == parts[-1] or text in parts[-1]:
        return
    parts.append(text)


def paragraphs(cues: Iterable[tuple[float, str]]) -> list[tuple[float, str]]:
    """Group nearby subtitle cues into short readable timestamped paragraphs."""
    result: list[tuple[int, str]] = []
    start: int | None = None
    previous_start: int | None = None
    parts: list[str] = []
    rolling_history = ""

    def flush() -> None:
        nonlocal start, parts
        if start is not None and parts:
            result.append((start, " ".join(parts)))
        start, parts[:] = None, []

    for cue_start, text in cues:
        text = trim_caption_overlap(rolling_history, text)
        if not text:
            previous_start = cue_start
            continue
        history_tokens = (rolling_history + " " + text).split()
        rolling_history = " ".join(history_tokens[-120:])
        gap = previous_start is not None and cue_start - previous_start > 5
        if start is None or gap or len(parts) >= 4:
            flush()
            start = cue_start
        parts.append(text)
        previous_start = cue_start
    flush()
    return result


def atomic_cues(cues: Iterable[tuple[float, str]]) -> list[tuple[float, str]]:
    """Remove rolling-caption overlap without merging cues or losing their timings."""
    result: list[tuple[float, str]] = []
    rolling_history = ""
    for cue_start, text in cues:
        text = trim_caption_overlap(rolling_history, text)
        if not text:
            continue
        history_tokens = (rolling_history + " " + text).split()
        rolling_history = " ".join(history_tokens[-120:])
        result.append((cue_start, text))
    return result


def pick_english_track(tracks: dict[str, object]) -> str | None:
    candidates = [language for language in tracks if ENGLISH_LANGUAGE.match(language)]
    if not candidates:
        return None
    return "en" if "en" in candidates else sorted(candidates)[0]


def pick_english_timing_track(tracks: dict[str, object]) -> str | None:
    candidates = [language for language in tracks if ENGLISH_LANGUAGE.match(language)]
    for preferred in ("en-orig", "en"):
        if preferred in candidates:
            return preferred
    return sorted(candidates)[0] if candidates else None


def youtube_subtitle_download(
    url: str, destination: Path
) -> tuple[dict[str, object], Path, Path | None, str]:
    try:
        import yt_dlp
    except ImportError:
        fail("找不到 yt-dlp。请先运行对应平台的依赖安装脚本。")

    inspect_options = {"quiet": True, "no_warnings": True, "skip_download": True, "noprogress": True}
    try:
        with yt_dlp.YoutubeDL(inspect_options) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        fail(f"无法读取这个 YouTube 视频：{exc}")

    manual_language = pick_english_track(info.get("subtitles") or {})
    automatic_language = pick_english_track(info.get("automatic_captions") or {})
    timing_language = pick_english_timing_track(info.get("automatic_captions") or {})
    if manual_language:
        source, language = "人工英文字幕", manual_language
    elif automatic_language:
        source, language = "自动英文字幕", automatic_language
    else:
        fail("这个视频没有可用的英文字幕。最小版本不会下载音频或调用语音识别。")

    def download_track(language_code: str, automatic: bool, folder: Path) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        download_options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "writesubtitles": not automatic,
            "writeautomaticsub": automatic,
            "subtitleslangs": [language_code],
            "subtitlesformat": "json3/vtt/best",
            "noprogress": True,
            "outtmpl": str(folder / "%(id)s.%(ext)s"),
        }
        try:
            with yt_dlp.YoutubeDL(download_options) as ydl:
                ydl.download([url])
        except yt_dlp.utils.DownloadError as exc:
            fail(f"英文字幕下载失败：{exc}")
        subtitle_files = sorted(
            [*folder.glob("*.json3"), *folder.glob("*.vtt")],
            key=lambda candidate: candidate.stat().st_mtime,
        )
        if not subtitle_files:
            fail("字幕下载没有生成 JSON3 或 VTT 文件。这个视频的字幕格式可能暂不兼容。")
        json3_files = [candidate for candidate in subtitle_files if candidate.suffix.lower() == ".json3"]
        return json3_files[-1] if json3_files else subtitle_files[-1]

    text_path = download_track(language, not bool(manual_language), destination / "text")
    timing_path = text_path
    if manual_language and timing_language:
        timing_path = download_track(timing_language, True, destination / "timing")
    return info, text_path, timing_path, source


def bilibili_json(url: str, require_code: bool = True) -> dict[str, object]:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        fail(f"无法读取 B 站视频信息：{exc}")
    if require_code and payload.get("code") != 0:
        fail(f"B 站接口返回错误：{payload.get('message') or payload.get('code')}")
    return payload


def bilibili_subtitle_download(url: str) -> tuple[dict[str, object], list[tuple[float, str]], str]:
    parsed = urlparse(url)
    match = BILIBILI_BVID.search(parsed.path)
    if not match:
        fail("无法从 B 站链接中识别 BV 号。")
    bvid = match.group(1)
    view = bilibili_json(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}").get("data") or {}
    pages = view.get("pages") or []
    requested_page = int((parse_qs(parsed.query).get("p") or ["1"])[0] or 1)
    page = next((item for item in pages if int(item.get("page") or 0) == requested_page), None)
    if not page:
        fail("这个 B 站分 P 不存在。")
    cid = int(page.get("cid") or 0)
    player = bilibili_json(f"https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}").get("data") or {}
    tracks = ((player.get("subtitle") or {}).get("subtitles") or [])
    english = next((track for track in tracks if ENGLISH_LANGUAGE.match(str(track.get("lan") or ""))), None)
    if not english:
        fail("这个 B 站视频没有可导出的英文字幕轨。画面中烧录的字幕无法自动变成精读稿。")
    subtitle_url = str(english.get("subtitle_url") or "")
    if subtitle_url.startswith("//"):
        subtitle_url = "https:" + subtitle_url
    if not subtitle_url:
        fail("B 站返回了英文字幕轨，但没有提供字幕地址。")
    subtitle = bilibili_json(subtitle_url, require_code=False)
    cues = []
    for item in subtitle.get("body") or []:
        text = clean_caption(str(item.get("content") or ""))
        if text:
            cues.append((round(float(item.get("from") or 0), 3), text))
    if not cues:
        fail("B 站英文字幕轨为空。")
    info = {
        "id": bvid,
        "title": str(page.get("part") or view.get("title") or "B站精听"),
        "channel": str((view.get("owner") or {}).get("name") or ""),
        "duration": int(page.get("duration") or view.get("duration") or 0),
        "webpage_url": url,
        "platform": "bilibili",
        "cid": cid,
        "page": requested_page,
    }
    return info, cues, f"B站英文字幕（{english.get('lan_doc') or english.get('lan')}）"


def safe_file_stem(title: str) -> str:
    cleaned = WINDOWS_RESERVED.sub("-", title).strip(" .-")
    return (cleaned or "YouTube 精听").replace("  ", " ")[:110]


def find_ffmpeg() -> str:
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    try:
        import imageio_ffmpeg
    except ImportError:
        fail("尚未安装本地音频组件 imageio-ffmpeg。")
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        fail(f"无法启动本地音频组件：{exc}")


def export_review_audio(
    url: str,
    output: Path,
    start: int | None,
    end: int | None,
    title: str,
    artist: str,
) -> None:
    try:
        import yt_dlp
    except ImportError:
        fail("缺少 yt-dlp。请先运行：python -m pip install yt-dlp")

    if (start is None) != (end is None):
        fail("音频片段必须同时提供开始和结束时间。")
    if start is not None and end is not None and start >= end:
        fail("音频片段结束时间必须晚于开始时间。")

    ffmpeg = find_ffmpeg()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="listening-review-audio-") as temp_directory:
        template = str(Path(temp_directory) / "source.%(ext)s")
        options = {
            "format": "bestaudio/best",
            "outtmpl": template,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
        }
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=True)
                source = Path(ydl.prepare_filename(info))
        except Exception as exc:
            fail(f"原声音频下载失败：{exc}")

        if not source.exists():
            candidates = [path for path in Path(temp_directory).glob("source.*") if path.is_file()]
            if not candidates:
                fail("音频已经下载，但没有找到临时文件。")
            source = candidates[0]

        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
        if start is not None:
            command.extend(["-ss", str(start)])
        command.extend(["-i", str(source)])
        if start is not None and end is not None:
            command.extend(["-t", str(end - start)])
        command.extend([
            "-vn",
            "-c:a", "aac",
            "-b:a", "96k",
            "-movflags", "+faststart",
            "-metadata", f"title={title}",
            "-metadata", f"artist={artist}",
            "-metadata", f"comment={url}",
            str(output),
        ])
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()
            fail(f"音频转换失败：{detail[-1] if detail else 'FFmpeg 未返回详细信息'}")
    print(f"AUDIO_FILE={output.resolve()}")


def markdown(
    info: dict[str, object],
    source: str,
    note_url: str,
    transcript: list[tuple[float, str]],
    segment_start: int,
    segment_end: int,
) -> str:
    platform = str(info.get("platform") or "youtube")
    title = str(info.get("title") or "口语精听")
    channel = str(info.get("channel") or info.get("uploader") or "")
    duration = int(info.get("duration") or 0)
    embed_value = info.get("playable_in_embed")
    browser_only = embed_value is False or str(embed_value).lower() in {"false", "no", "0"}
    lines = [
        "---",
        "type: listening-practice",
        f"source: {platform}",
        f"url: {note_url}",
        f"channel: {channel}",
        f"duration_seconds: {duration}",
        f"segment: {display_timestamp(segment_start)}-{display_timestamp(segment_end)}",
        f"captions: {source}",
        f"playback: {'browser-only' if browser_only else 'embedded'}",
        f"created: {date.today().isoformat()}",
        "status: imported",
        "---",
        "",
        f"# {title}",
        "",
        f"学习片段：{display_timestamp(segment_start)}–{display_timestamp(segment_end)}",
        "",
    ]
    if browser_only:
        lines.extend([
            "> [!warning] 这个视频的发布者禁止第三方嵌入播放。",
            "> 时间戳将直接交给默认浏览器，无法使用 Obsidian 右侧常驻播放器。",
            "",
        ])
    lines.extend([
        "## 使用方式",
        "",
        "1. 先不看稿听一遍，只标记断掉的位置。",
        "2. 精读时只处理：看稿也不懂，或看稿懂但声音没听出来的地方。",
        "3. 点击时间戳回到原声；最后关稿再听一遍。",
        "",
        "## Transcript",
        "",
    ])
    video_id = str(info.get("id") or "")
    for seconds, text in transcript:
        link = f"obsidian://youtube-listening?platform={platform}&video={video_id}&t={seconds}"
        if platform == "bilibili":
            link += f"&cid={int(info.get('cid') or 0)}&p={int(info.get('page') or 1)}"
        if browser_only:
            link += "&external=1"
        lines.extend([f"### [{display_timestamp(seconds)}]({link})", "", text, ""])
    lines.extend([
        "## 我的标记",
        "",
        "- 看稿也不懂：",
        "- 看稿懂，但原声没有听出来：",
        "- 关稿复听仍断掉的位置：",
        "",
    ])
    return "\n".join(lines)


def transcript_payload(
    info: dict[str, object],
    source: str,
    note_url: str,
    transcript: list[tuple[float, str]],
    timed_words: list[tuple[float, str]],
    segment_start: int,
    segment_end: int,
) -> dict[str, object]:
    platform = str(info.get("platform") or "youtube")
    video_id = str(info.get("id") or "")
    embed_value = info.get("playable_in_embed")
    browser_only = embed_value is False or str(embed_value).lower() in {"false", "no", "0"}
    segments = []
    for seconds, text in transcript:
        link = f"obsidian://youtube-listening?platform={platform}&video={video_id}&t={seconds}"
        if platform == "bilibili":
            link += f"&cid={int(info.get('cid') or 0)}&p={int(info.get('page') or 1)}"
        if browser_only:
            link += "&external=1"
        segments.append({"t": seconds, "href": link, "text": text})
    return {
        "title": str(info.get("title") or "口语精听"),
        "channel": str(info.get("channel") or info.get("uploader") or ""),
        "duration": int(info.get("duration") or 0),
        "platform": platform,
        "video_id": video_id,
        "source": source,
        "url": note_url,
        "segment_start": segment_start,
        "segment_end": segment_end,
        "browser_only": browser_only,
        "segments": segments,
        "words": [{"t": seconds, "text": text} for seconds, text in timed_words],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="将 YouTube 或 B 站英文字幕导入 Obsidian。")
    parser.add_argument("url", nargs="?", help="YouTube 或 B 站视频链接；省略时会提示输入。")
    parser.add_argument("--vault", type=Path, default=DEFAULT_VAULT, help="Obsidian 库根目录。")
    parser.add_argument("--folder", default=DEFAULT_FOLDER, help="库内保存笔记的文件夹。")
    parser.add_argument("--start", type=parse_user_timestamp, help="长视频学习片段的起点，如 02:30。")
    parser.add_argument("--end", type=parse_user_timestamp, help="长视频学习片段的终点，如 07:00。")
    parser.add_argument("--emit-json", action="store_true", help="只输出字幕 JSON，不创建 Obsidian 笔记。")
    parser.add_argument("--export-audio", action="store_true", help="下载原声并导出 M4A 复听音频。")
    parser.add_argument("--audio-output", type=Path, help="复听音频的 M4A 输出路径。")
    parser.add_argument("--audio-title", default="口语精听复听", help="写入音频文件的标题。")
    parser.add_argument("--audio-artist", default="", help="写入音频文件的频道或作者。")
    args = parser.parse_args()

    url = args.url or input("粘贴 YouTube 或 B 站链接：").strip()
    if not url:
        fail("没有收到视频链接。")
    is_youtube = "youtube.com" in url or "youtu.be" in url
    is_bilibili = "bilibili.com" in url or "b23.tv" in url
    if not is_youtube and not is_bilibili:
        fail("目前只支持 YouTube 或 B 站视频链接。")
    if args.export_audio:
        if not args.audio_output:
            fail("导出音频时必须提供 --audio-output。")
        export_review_audio(
            url,
            args.audio_output,
            args.start,
            args.end,
            args.audio_title,
            args.audio_artist,
        )
        return
    if not args.vault.exists():
        fail(f"找不到 Obsidian 库：{args.vault}")

    if is_bilibili:
        if "b23.tv" in url:
            fail("请粘贴浏览器地址栏中的完整 B 站视频链接，而不是 b23.tv 短链接。")
        info, cues, source = bilibili_subtitle_download(url)
        timed_words: list[tuple[float, str]] = []
    else:
        with tempfile.TemporaryDirectory(prefix="youtube-captions-") as temp_directory:
            info, subtitle_path, timing_path, source = youtube_subtitle_download(url, Path(temp_directory))
            cues, text_timed_words = parse_subtitle(subtitle_path)
            if timing_path and timing_path != subtitle_path:
                _, timed_words = parse_subtitle(timing_path)
            else:
                timed_words = text_timed_words
        info["platform"] = "youtube"

    duration = int(info.get("duration") or (cues[-1][0] if cues else 0))
    if (args.start is None) != (args.end is None):
        fail("长视频片段必须同时填写开始时间和结束时间。")
    if args.start is None:
        segment_start, segment_end = 0, duration
    else:
        segment_start, segment_end = args.start, args.end
        if segment_start >= segment_end:
            fail("片段结束时间必须晚于开始时间。")
        if segment_end > duration + 5:
            fail(f"片段终点超过视频时长 {display_timestamp(duration)}。")

    selected_cues = [
        (cue_start, text)
        for cue_start, text in cues
        if segment_start <= cue_start < segment_end
    ]
    transcript = atomic_cues(selected_cues) if args.emit_json else paragraphs(selected_cues)
    if not transcript:
        fail("字幕内容为空，无法创建笔记。")

    note_url = str(info.get("webpage_url") or url)
    if args.emit_json:
        selected_words = [
            (word_start, text)
            for word_start, text in timed_words
            if segment_start <= word_start < segment_end
        ]
        if not selected_words:
            selected_words = [
                (cue_start, match.group(0))
                for cue_start, text in transcript
                for match in WORD.finditer(text)
            ]
        payload = transcript_payload(
            info, source, note_url, transcript, selected_words, segment_start, segment_end
        )
        print(f"TRANSCRIPT_JSON={json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}")
        return

    output_folder = args.vault / args.folder
    output_folder.mkdir(parents=True, exist_ok=True)
    output = output_folder / f"{safe_file_stem(str(info.get('title') or 'YouTube 精听'))}.md"
    suffix = 2
    while output.exists():
        output = output_folder / f"{safe_file_stem(str(info.get('title') or 'YouTube 精听'))} ({suffix}).md"
        suffix += 1
    output.write_text(
        markdown(info, source, note_url, transcript, segment_start, segment_end),
        encoding="utf-8",
    )
    print(f"\n已创建：{output}")
    print(f"字幕来源：{source}；整理为 {len(transcript)} 个时间段。")
    embed_value = info.get("playable_in_embed")
    browser_only = embed_value is False or str(embed_value).lower() in {"false", "no", "0"}
    print(f"BROWSER_ONLY={1 if browser_only else 0}")
    print(f"NOTE_PATH={output.resolve()}")


if __name__ == "__main__":
    main()
