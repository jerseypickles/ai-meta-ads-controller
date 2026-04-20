/**
 * Zeus Voice — TTS queue + STT (mic)
 *
 * TTS: chunka el texto streameado por frases completas, pide audio a /api/zeus/tts,
 * y reproduce en orden. Expone callbacks onPlayStart/onPlayEnd/onLevel (simple).
 *
 * STT: wrapper del Web Speech API con start/stop/onTranscript.
 */

function getApiBase() {
  return import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');
}

function getToken() {
  return localStorage.getItem('auth_token');
}

// ═══════════════════════════════════════════════════════════════════════════
// TTS QUEUE
// ═══════════════════════════════════════════════════════════════════════════

export class ZeusVoice {
  constructor({ voice = 'onyx', onSpeakStart, onSpeakEnd, onQueueDrained } = {}) {
    this.voice = voice;
    this.onSpeakStart = onSpeakStart || (() => {});
    this.onSpeakEnd = onSpeakEnd || (() => {});
    this.onQueueDrained = onQueueDrained || (() => {});

    // Buffer de texto streameado, se vacía por frases completas
    this._textBuffer = '';
    // Queue de audios pendientes (blobs)
    this._audioQueue = [];
    this._playing = false;
    this._muted = false;
    this._unlocked = false; // autoplay unlock
    this._fetchesInFlight = 0;
    this._stopped = false;

    this._audio = typeof Audio !== 'undefined' ? new Audio() : null;
    if (this._audio) {
      this._audio.addEventListener('ended', () => this._playNext());
      this._audio.addEventListener('error', () => this._playNext());
    }
  }

  /** Marca que el usuario interactuó — desbloquea autoplay. */
  unlock() {
    this._unlocked = true;
    // Kickstart audio context con un play silencioso si hace falta
    if (this._audio && this._audio.paused) {
      this._audio.muted = true;
      const p = this._audio.play();
      if (p?.catch) p.catch(() => {});
      this._audio.pause();
      this._audio.muted = false;
    }
  }

  isUnlocked() {
    return this._unlocked;
  }

  setMuted(muted) {
    this._muted = !!muted;
    if (muted && this._audio && !this._audio.paused) {
      this._audio.pause();
    }
  }

  isMuted() {
    return this._muted;
  }

  /** Alimenta texto incremental desde el stream de Claude. */
  feed(deltaText) {
    if (this._muted || this._stopped) return;
    this._textBuffer += deltaText;
    this._flushCompleteSentences();
  }

  /** Marca fin de stream — flush lo que quede. */
  finish() {
    if (this._muted || this._stopped) return;
    const rest = this._textBuffer.trim();
    if (rest) this._enqueueText(rest);
    this._textBuffer = '';
  }

  /** Stop y limpia todo. */
  stop() {
    this._stopped = true;
    this._textBuffer = '';
    this._audioQueue = [];
    if (this._audio && !this._audio.paused) this._audio.pause();
    this._playing = false;
  }

  reset() {
    this.stop();
    this._stopped = false;
  }

  /**
   * Divide el buffer por frases completas (terminadas en . ! ? … \n) y
   * encola cada frase. Deja el resto en el buffer.
   */
  _flushCompleteSentences() {
    // Regex: agrupa hasta un terminador inclusive, respetando comillas
    const regex = /[^.!?¡¿…\n]+[.!?¡¿…\n]+/g;
    const matches = this._textBuffer.match(regex) || [];

    if (matches.length === 0) {
      // Safety valve: si el buffer se pasa de largo sin terminar oración, flusheá igual
      if (this._textBuffer.length > 200) {
        this._enqueueText(this._textBuffer.trim());
        this._textBuffer = '';
      }
      return;
    }

    const consumed = matches.join('');
    const rest = this._textBuffer.slice(consumed.length);

    for (const m of matches) {
      const t = m.trim();
      if (t.length >= 2) this._enqueueText(t);
    }
    this._textBuffer = rest;
  }

  async _enqueueText(text) {
    if (this._muted || this._stopped) return;
    this._fetchesInFlight += 1;
    try {
      const audioBlob = await this._fetchAudio(text);
      if (this._stopped) return;
      this._audioQueue.push(audioBlob);
      this._maybePlay();
    } catch (err) {
      console.warn('Zeus TTS fetch failed:', err.message);
    } finally {
      this._fetchesInFlight -= 1;
      if (this._fetchesInFlight === 0 && this._audioQueue.length === 0 && !this._playing) {
        this.onQueueDrained();
      }
    }
  }

  async _fetchAudio(text) {
    const res = await fetch(`${getApiBase()}/api/zeus/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify({ text, voice: this.voice })
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
    return await res.blob();
  }

  _maybePlay() {
    if (this._playing || this._muted || this._stopped) return;
    if (!this._audio) return;
    if (this._audioQueue.length === 0) return;

    const next = this._audioQueue.shift();
    const url = URL.createObjectURL(next);
    this._audio.src = url;
    this._playing = true;
    this.onSpeakStart();
    const p = this._audio.play();
    if (p?.catch) {
      p.catch(err => {
        console.warn('Audio play failed (likely autoplay block):', err.message);
        this._playing = false;
        URL.revokeObjectURL(url);
      });
    }
  }

  _playNext() {
    this._playing = false;
    this.onSpeakEnd();
    if (this._audioQueue.length > 0) {
      this._maybePlay();
    } else if (this._fetchesInFlight === 0) {
      this.onQueueDrained();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STT — Web Speech API wrapper
// ═══════════════════════════════════════════════════════════════════════════

export class ZeusMic {
  constructor({ lang = 'es-ES', onTranscript, onPartial, onStart, onEnd, onError } = {}) {
    this.lang = lang;
    this.onTranscript = onTranscript || (() => {});
    this.onPartial = onPartial || (() => {});
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onError = onError || (() => {});
    this._recognition = null;
    this._listening = false;
    this._lastFinal = '';
  }

  static isSupported() {
    return typeof window !== 'undefined' &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (this._listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.onError(new Error('SpeechRecognition no soportado en este browser'));
      return;
    }

    this._recognition = new SR();
    this._recognition.lang = this.lang;
    this._recognition.continuous = false;
    this._recognition.interimResults = true;
    this._lastFinal = '';

    this._recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) this.onPartial(interim);
      if (final) {
        this._lastFinal += final;
      }
    };

    this._recognition.onend = () => {
      this._listening = false;
      const transcript = this._lastFinal.trim();
      if (transcript) this.onTranscript(transcript);
      this.onEnd();
    };

    this._recognition.onerror = (e) => {
      this._listening = false;
      this.onError(e);
    };

    try {
      this._recognition.start();
      this._listening = true;
      this.onStart();
    } catch (err) {
      this.onError(err);
    }
  }

  stop() {
    if (this._recognition && this._listening) {
      try { this._recognition.stop(); } catch (_) {}
    }
  }

  isListening() {
    return this._listening;
  }
}
