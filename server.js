const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());

const upload = multer({ dest: os.tmpdir() });

app.get('/', (req, res) => {
  res.send('Reel Builder render server is running.');
});

app.post('/merge', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), (req, res) => {
  const jobId = crypto.randomUUID();
  const speed = parseFloat(req.body.speed || '2') || 2;

  if (!req.files || !req.files.video || !req.files.audio) {
    return res.status(400).json({ error: 'Both video and audio files are required.' });
  }

  const videoPath = req.files.video[0].path;
  const audioPath = req.files.audio[0].path;
  const outputPath = path.join(os.tmpdir(), jobId + '-output.mp4');

  const args = [
    '-y',
    '-stream_loop', '-1', '-i', videoPath,
    '-i', audioPath,
    '-filter:v', `setpts=PTS/${speed},fps=30,scale=720:-2`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart',
    outputPath
  ];

  execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
    // Clean up the uploaded input files regardless of outcome.
    fs.unlink(videoPath, () => {});
    fs.unlink(audioPath, () => {});

    if (err) {
      console.error('ffmpeg failed:', stderr);
      return res.status(500).json({ error: 'ffmpeg failed', detail: stderr.slice(-2000) });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="vynxstories content.mp4"');
    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', () => { fs.unlink(outputPath, () => {}); });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on port ' + PORT));
