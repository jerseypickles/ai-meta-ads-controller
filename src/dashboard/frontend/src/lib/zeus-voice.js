/**
 * Zeus Voice — TTS queue + STT (mic)
 *
 * TTS: chunka el texto streameado por frases completas, pide audio a /api/zeus/tts,
 * y reproduce en orden. Fallback a speechSynthesis si OpenAI TTS falla.
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

    this._textBuffer = '';
    this._audioQueue = [];
    this._playing = false;
    this._muted = false;
    this._unlocked = false;
    this._unlocking = false;
    this._fetchesInFlight = 0;
    this._stopped = false;
    this._permanentFallback = false; // solo si la key no sirve del todo (401/403)

    this._audio = null;
    this._audioContext = null;
    this._preferredVoice = null;

    // Pre-cargar voces (algunos browsers cargan async)
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      const loadVoices = () => {
        this._preferredVoice = this._pickBrowserVoice();
      };
      loadVoices();
      try {
        window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
      } catch (_) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
      }
    }
  }

  /** Desbloquea audio — DEBE invocarse sincrónicamente desde un event handler. */
  unlock() {
    if (this._unlocked || this._unlocking) return;
    this._unlocking = true;

    // 1. AudioContext — el pattern más confiable en Safari
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this._audioContext = new AudioCtx();
        if (this._audioContext.state === 'suspended') {
          this._audioContext.resume().catch(() => {});
        }
        // Play un buffer silencioso — cuenta como interacción de audio
        const buffer = this._audioContext.createBuffer(1, 1, 22050);
        const source = this._audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this._audioContext.destination);
        source.start(0);
      }
    } catch (err) {
      console.warn('Zeus: AudioContext setup failed:', err.message);
    }

    // 2. HTMLAudioElement para playback de mp3 streameado (OpenAI)
    try {
      if (!this._audio && typeof Audio !== 'undefined') {
        this._audio = new Audio();
        this._audio.preload = 'auto';
        this._audio.addEventListener('ended', () => this._playNext());
        this._audio.addEventListener('error', () => {
          console.warn('Zeus audio error:', this._audio?.error);
          this._playNext();
        });
      }
    } catch (err) {
      console.warn('Zeus: audio element setup failed:', err.message);
    }

    // 3. Unlock speechSynthesis tirando una utterance silenciosa
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        const silent = new SpeechSynthesisUtterance(' ');
        silent.volume = 0;
        window.speechSynthesis.speak(silent);
      }
    } catch (_) {}

    this._unlocked = true;
    this._unlocking = false;
  }

  _pickBrowserVoice() {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;

    const malePatterns = /jorge|diego|juan|pablo|carlos|enrique|miguel|eduardo|francisco|roberto|alejandro|google español|spanish united/i;
    const femalePatterns = /mónica|monica|paulina|marisol|esperanza|rosa|angela|carmen|isabel|luc[ií]a|mar[ií]a|sof[ií]a|lupe|female/i;

    const explicitMale = voices.find(v => /^es/i.test(v.lang) && malePatterns.test(v.name));
    if (explicitMale) return explicitMale;

    const nonFemaleEs = voices.find(v => /^es/i.test(v.lang) && !femalePatterns.test(v.name));
    if (nonFemaleEs) return nonFemaleEs;

    const anyEs = voices.find(v => /^es/i.test(v.lang));
    if (anyEs) return anyEs;

    return voices[0] || null;
  }

  isUnlocked() {
    return this._unlocked;
  }

  setMuted(muted) {
    this._muted = !!muted;
    if (muted) {
      if (this._audio && !this._audio.paused) this._audio.pause();
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (_) {}
      }
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
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    this._playing = false;
  }

  reset() {
    this.stop();
    this._stopped = false;
  }

  _flushCompleteSentences() {
    const regex = /[^.!?¡¿…\n]+[.!?¡¿…\n]+/g;
    const matches = this._textBuffer.match(regex) || [];

    if (matches.length === 0) {
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

    // Si ya confirmamos que no hay OpenAI key en este servidor, no intentamos
    if (this._permanentFallback) {
      this._speakWithBrowser(text);
      return;
    }

    this._fetchesInFlight += 1;
    try {
      const audioBlob = await this._fetchAudio(text);
      if (this._stopped) return;

      // AudioContext (Safari friendly)
      if (this._audioContext) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const audioBuffer = await this._audioContext.decodeAudioData(arrayBuffer.slice(0));
          if (this._stopped) return;
          console.info('[Zeus] OpenAI TTS playback via AudioContext');
          this._audioQueue.push({ buffer: audioBuffer, text });
          this._maybePlay();
          return;
        } catch (decodeErr) {
          console.warn('[Zeus] AudioContext decode failed, trying HTMLAudioElement:', decodeErr.message);
        }
      }

      // Fallback HTMLAudioElement
      console.info('[Zeus] OpenAI TTS playback via HTMLAudioElement');
      this._audioQueue.push({ blob: audioBlob, text });
      this._maybePlay();
    } catch (err) {
      console.warn('[Zeus] TTS fetch failed esta vez, usando speechSynthesis:', err.message);
      // Solo marcar fallback permanente si es 401/403/404 (config problem),
      // no para 429/500/timeout que son transitorios
      if (/HTTP 401|HTTP 403|HTTP 404|HTTP 503/.test(err.message)) {
        this._permanentFallback = true;
        console.warn('[Zeus] OpenAI TTS deshabilitado permanentemente este sesión');
      }
      this._speakWithBrowser(text);
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
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`TTS HTTP ${res.status}: ${errText.substring(0, 100)}`);
    }
    return await res.blob();
  }

  /** Fallback: TTS del browser. Mejor que silencio aunque sea más robótico. */
  _speakWithBrowser(text) {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      console.warn('Zeus: ni OpenAI TTS ni speechSynthesis disponibles');
      return;
    }
    // Refrescar voz preferida por si las voces cargaron después del init
    if (!this._preferredVoice) this._preferredVoice = this._pickBrowserVoice();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'es-ES';
    utter.rate = 1.0;
    utter.pitch = 0.85; // más grave tipo Zeus
    if (this._preferredVoice) utter.voice = this._preferredVoice;

    utter.onstart = () => { this._playing = true; this.onSpeakStart(); };
    utter.onend = () => {
      this._playing = false;
      this.onSpeakEnd();
      if (this._audioQueue.length === 0 && this._fetchesInFlight === 0) this.onQueueDrained();
    };
    utter.onerror = () => { this._playing = false; this.onSpeakEnd(); };
    window.speechSynthesis.speak(utter);
  }

  _maybePlay() {
    if (this._playing || this._muted || this._stopped) return;
    if (this._audioQueue.length === 0) return;

    const next = this._audioQueue.shift();

    // Camino 1: AudioBuffer via AudioContext (Safari friendly)
    if (next.buffer && this._audioContext) {
      try {
        const source = this._audioContext.createBufferSource();
        source.buffer = next.buffer;
        source.connect(this._audioContext.destination);
        source.onended = () => this._playNext();
        this._playing = true;
        this.onSpeakStart();
        source.start(0);
        return;
      } catch (err) {
        console.warn('AudioContext playback failed:', err.message);
      }
    }

    // Camino 2: HTMLAudioElement (fallback)
    if (!this._audio || !next.blob) {
      if (next.text) this._speakWithBrowser(next.text);
      return;
    }

    const url = URL.createObjectURL(next.blob);
    this._audio.src = url;
    this._playing = true;
    this.onSpeakStart();
    const p = this._audio.play();
    if (p?.catch) {
      p.catch(err => {
        console.warn('Audio play failed para este chunk, fallback a speechSynthesis:', err.message);
        this._playing = false;
        URL.revokeObjectURL(url);
        if (next.text) this._speakWithBrowser(next.text);
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
      if (final) this._lastFinal += final;
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
