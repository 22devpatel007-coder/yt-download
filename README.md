# YouTube Downloader Web App

A powerful Node.js based local web application for downloading YouTube videos as high-quality MP3 audio files. The application supports individual songs and playlists, automatically extracting metadata (like artist and title information) and album art (thumbnails) and packaging everything neatly into a `.zip` file for easy downloading.

## Features

- **Video Preview**: Fetch details like title, uploader, and thumbnail from a given YouTube link.
- **Quality Selection**: See available audio quality formats and sizes before downloading.
- **Audio Extraction**: Uses `yt-dlp` and `ffmpeg` to extract the best quality audio.
- **Playlist Support**: Can download multiple tracks at once and zip them up.
- **Real-time Progress**: Emits downloading progress via Server-Sent Events (SSE).
- **Metadata & Album Art**: Automatically injects metadata and cover art into the downloaded MP3 files.

## Prerequisites

Before you can run this application, make sure you have the following installed on your system:
- **[Node.js](https://nodejs.org/)** (v14 or higher recommended)
- **[FFmpeg](https://ffmpeg.org/download.html)** (Required for audio extraction and metadata embedding)

> [!WARNING]  
> The path for `ffmpeg` is currently hardcoded in `server.js` (`C:/ffmpeg-2026-03-30-git-e54e117998-essentials_build/bin/ffmpeg.exe`). **You will need to update this path to point to your local FFmpeg installation.**

## Installation

1. **Clone or Download** the repository to your local machine.
2. **Navigate** into the project directory:
   ```bash
   cd yt-download
   ```
3. **Install Dependencies**:
   ```bash
   npm install
   ```
   *This will install `express`, `yt-dlp-exec`, and `archiver`.*

## Running the Server

Start the local server by running:

```bash
npm start
```
By default, the server runs on `http://localhost:3030`. 
If you have a frontend configured in the `public/` directory, simply open your browser and navigate to the localhost URL.

## API Endpoints

- `POST /preview`
  - Accepts a JSON payload `{ "url": "..." }` and returns video title, artist, and thumbnail.
- `POST /formats`
  - Accepts a JSON payload `{ "url": "..." }` and returns available audio formats and estimated sizes.
- `GET /download-progress?url=...&quality=192`
  - A Server-Sent Events (SSE) endpoint that initiates the audio download, zips the files and streams progress updates.
- `GET /file/:name`
  - Serves the final `.zip` file containing downloaded audio and metadata.

## Technologies Used

- **Node.js** & **Express**: Backend web server framework.
- **[yt-dlp-exec](https://github.com/microlinkhq/yt-dlp-exec)**: JavaScript wrapper over `yt-dlp` for video downloading.
- **[Archiver](https://github.com/archiverjs/node-archiver)**: For compressing multiple downloaded songs into a `.zip` file.
- **FFmpeg**: For converting media files and baking in thumbnails. 

## License

ISC License
