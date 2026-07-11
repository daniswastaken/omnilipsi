import { YtDlp } from 'ytdlp-nodejs';

const ytdlp = new YtDlp();

await ytdlp.downloadAsync('https://youtu.be/oKG0hwtYH0c?si=x27d2Jz2c9QrhUPP', {
  format: { filter: 'audioandvideo', quality: 'highest', type: 'mp4' },
  onProgress: (progress) => console.log(`${progress.percentage_str}`),
});
