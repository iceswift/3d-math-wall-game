// Tiny WebAudio synth for all sound effects.
let audioCtx = null;
let muted = localStorage.getItem('mathwall-muted') === '1';

export function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  localStorage.setItem('mathwall-muted', m ? '1' : '0');
}

function tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

export const sfx = {
  press: () => tone(340, 0.08, 'square', 0.08),
  success: () => { tone(660, 0.12, 'sine', 0.18); tone(880, 0.22, 'sine', 0.16, 0.09); tone(1320, 0.3, 'sine', 0.1, 0.18); },
  perfect: () => { tone(880, 0.1, 'sine', 0.18); tone(1175, 0.12, 'sine', 0.16, 0.08); tone(1760, 0.35, 'sine', 0.12, 0.16); },
  fail: () => { tone(200, 0.25, 'sawtooth', 0.2); tone(120, 0.4, 'sawtooth', 0.18, 0.1); },
  match: () => tone(520, 0.1, 'triangle', 0.1),
  wave: () => { tone(440, 0.15, 'triangle', 0.14); tone(660, 0.25, 'triangle', 0.12, 0.12); },
  boss: () => { tone(110, 0.5, 'sawtooth', 0.14); tone(165, 0.5, 'sawtooth', 0.1, 0.05); },
  tick: () => tone(1200, 0.04, 'square', 0.05),
  slow: () => { tone(300, 0.35, 'sine', 0.14); tone(150, 0.5, 'sine', 0.1, 0.1); },
  // cartoon dizzy warble: alternating falling tones, like a wobbling head
  dizzy: () => {
    const seq = [392, 330, 370, 311, 349, 294];
    seq.forEach((f, i) => tone(f, 0.09, 'triangle', 0.12, 0.08 + i * 0.085));
  },
  skip: () => { tone(520, 0.12, 'sawtooth', 0.12); tone(260, 0.22, 'sawtooth', 0.1, 0.08); },
};
