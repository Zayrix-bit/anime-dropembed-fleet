# ⚡ Anime DropEmbed Fleet Pipeline

Distributed GitHub Actions Matrix fleet that remuxes HLS anime streams directly to MP4 and uploads them to [DropEmbed](https://dropembed.com) at scale.

## 🚀 Features

- **10-Shard Parallel Matrix Execution**: 10 GitHub Actions runners process the anime queue simultaneously using `id % 10` partitioning.
- **Dedicated DropEmbed Database Isolation**: All streams and metadata are tracked separately in `dropembed_anime_series` and `dropembed_anime_episodes` tables within the `jeevanka_anime` database.
- **High-Quality Cascading FFmpeg Remuxer**: Tests stream candidates in order of quality (`1080p` ➔ `720p` ➔ `480p` ➔ `360p` ➔ `240p`), remuxes audio/video without re-encoding (`-c copy`), and uploads the highest available resolution.
- **Self-Healing Stream Resolver**: Automatically resolves and caches missing stream identifiers directly from Blakite API on-the-fly.
- **DropEmbed API Integration**: Uploads via `POST https://dropembed.com/api/videos/upload` with retry logic, rate limit backoff, and direct embed/player URL generation (`https://dropembed.com/v/{video_id}`).

---

## 🛠️ Required Repository Secrets

Configure the following secrets in GitHub Repository Settings (`Settings` ➔ `Secrets and variables` ➔ `Actions`):

| Secret | Value / Description |
| :--- | :--- |
| `DB_HOST` | MySQL Server Host (`37.27.232.161`) |
| `DB_PORT` | MySQL Server Port (`3306`) |
| `DB_USER` | MySQL Username (`jeevanka_user`) |
| `DB_PASSWORD` | MySQL Password |
| `DB_NAME` | Database Name (`jeevanka_anime`) |
| `DROPEMBED_API_KEY` | DropEmbed API Key (`dpe_live_...`) |

---

## 🏃 Running the Fleet

### Trigger via GitHub Actions UI
1. Navigate to the **Actions** tab on GitHub.
2. Select **Anime DropEmbed Fleet Pipeline**.
3. Click **Run workflow**:
   - `test_mode`: `true` to process 1 episode per shard (smoke test), or `false` for full run.
   - `max_episodes`: Maximum episodes per shard worker (`0` for unlimited until queue is empty).
