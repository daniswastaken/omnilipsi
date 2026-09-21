import { YtDlp } from 'ytdlp-nodejs';

// Local power mode: full yt-dlp extraction on your own machine.
// Usage: npm run dl -- "https://youtu.be/...." [--mp3]
// (Workers can't spawn binaries, so this stays a local CLI.)

const url = process.argv[2];
const mp3 = process.argv.includes('--mp3');

if (!url || !/^https?:\/\//i.test(url)) {
  console.error('Usage: npm run dl -- "<https-url>" [--mp3]');
  process.exit(1);
}

const ytdlp = new YtDlp();

const opts = mp3
  ? {
      format: { filter: 'audioonly', quality: 'highest', type: 'mp3' },
      onProgress: (p) => process.stdout.write(`\r${p.percentage_str ?? ''}`),
    }
  : {
      format: { filter: 'audioandvideo', quality: 'highest', type: 'mp4' },
      onProgress: (p) => process.stdout.write(`\r${p.percentage_str ?? ''}`),
    };

try {
  await ytdlp.downloadAsync(url, opts);
  console.log('\nDone.');
} catch (err) {
  console.error('\nDownload failed:', err?.message || err);
  process.exit(1);
}
