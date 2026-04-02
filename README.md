# YouTube MP3 Downloader

A powerful Node.js local web application for downloading YouTube videos and playlists as high-quality MP3 files. It supports downloading single tracks or full playlists, automatically extracting metadata (like artist and title) and album art, and delivering them as easily downloadable `.zip` archives or individual MP3 files.

## Features

- **Video & Playlist Preview**: Retrieve title, uploader, thumbnail, and track count from a YouTube link.
- **Quality Selection**: Pick between multiple audio bitrates (320, 256, 192, 128, 96 kbps).
- **Two Download Modes**:
  - **Structured ZIP**: Downloads tracks into a `songs/` folder, album art into a `covers/` folder, and includes a `manifest.json`.
  - **Flat ZIP**: Downloads all plain MP3 files directly into the root of the ZIP file without extra folders or covers.
- **Individual Track Downloads**: Automatically extracts and serves individual MP3 files directly from the ZIP archive using `adm-zip`.
- **Real-time Progress UI**: Shows downloading progress for individual tracks and playlists via Server-Sent Events (SSE).
- **Metadata & Album Art Embedding**: Automatically injects tags and thumbnails directly into the downloaded MP3 files using `ffmpeg`.
- **Session Management & Auto-Cleanup**: Automatically cleans up generated `.zip` files and temporary files.

## Project Architecture

The application handles its complex operations via cleanly separated, domain-driven modules:
- **`config/`**: Serves as the single source of truth for variables such as `PORT`, `CONCURRENCY`, and paths to `ffmpeg`.
- **`downloader/`**: The core data extraction engine handling independent domain logic (fetching tracks, extracting covers, parallel worker queues, manifest builders).
- **`engine/`**: The centralized orchestrator (`runDownload.js`) controlling the flow between downloading arrays, archiving files, and emitting events.
- **`middleware/`**: Shared route protection (CORS handling, Memory-based Rate Limiter).
- **`routes/`**: Distinct Express setups for Previewing, Finding Formats, Streaming ZIP packages, and Serving local files.
- **`sessions/`**: Singleton in-memory map storing tracking metrics mapped against interval-based cleanup sweeps.
- **`utils/`**: Shared helper properties (URL parsing, safe name serialization, duration formatting, ffmpeg executions).
- **`server.js`**: The minimal entry point linking environment context, middlewares, routes, and booting the listening server.

## Prerequisites

Before running the application, make sure you have:
- **[Node.js](https://nodejs.org/)** (v14 or higher)
- **[FFmpeg](https://ffmpeg.org/download.html)**: Required for audio extraction and metadata embedding.

## Installation & Configuration

1. **Clone or Download** the repository to your machine.
2. **Navigate** into the project directory:
   ```bash
   cd yt-download
   ```
3. **Install Dependencies**:
   ```bash
   npm install
   ```
4. **Environment Variables**:
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and configure your settings:
   - `PORT`: Define the port for the web server (default: 3030).
   - `FFMPEG_PATH`: The path to your FFmpeg executable. If FFmpeg is already in your system's PATH, you can set this to `ffmpeg`.
   - `CONCURRENCY`: Define how many parallel track downloads execute simultaneously (default: 3).

## Running the Server

Start the local server by running:

```bash
npm start
```
By default, the server runs on `http://localhost:3030`. 
Open your browser and navigate to this URL to use the web interface.

## API Endpoints

- `POST /preview-playlist`
  - Accepts `{ "url": "..." }` and returns video title, artist, thumbnail, and track count.
- `POST /formats`
  - Accepts `{ "url": "..." }` and returns available audio formats and sizes based on bitrates.
- `GET /download-progress?url=...&quality=192`
  - SSE endpoint that initiates a **structured ZIP** download and streams progress updates.
- `GET /download-flat?url=...&quality=192`
  - SSE endpoint that initiates a **flat ZIP** download (MP3 files only) and streams progress updates.
- `GET /file/:name`
  - Serves a generated `.zip` file from the downloads directory.
- `GET /song/:sessionId/:index`
  - Extracts and serves an individual MP3 track directly from the session's ZIP archive.
- `GET /cover/:sessionId/:index`
  - Extracts and serves a specific track's cover image from the structured ZIP archive.

## Technologies Used

- **Node.js** & **Express**: Backend web server framework.
- **[yt-dlp-exec](https://github.com/microlinkhq/yt-dlp-exec)**: JavaScript wrapper over `yt-dlp` for extracting audio.
- **[Archiver](https://github.com/archiverjs/node-archiver)**: For compressing multiple downloaded songs into a `.zip` file on the fly.
- **[adm-zip](https://github.com/cthackers/adm-zip)**: Serves individual files dynamically from completed ZIP archives.
- **FFmpeg**: For format conversion, cover art embedding, and audio extraction.
