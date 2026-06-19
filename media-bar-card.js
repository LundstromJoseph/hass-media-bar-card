'use strict';

const SUPPRESS_MS = 2000;

class MediaBarCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._localVol = null;
    this._suppressUntil = 0;
    this._isDragging = false;
    this._currentMode = null; // 'media' | 'minimal'
  }

  setConfig(config) {
    if (!config.entity) throw new Error('entity is required');
    this._config = config;
    this._currentMode = null;
    this._setupDOM();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._isDragging || Date.now() < this._suppressUntil) return;
    this._localVol = null;
    const mode = this._resolveMode();
    if (mode !== this._currentMode) {
      this._currentMode = mode;
      this._setupDOM();
    } else {
      this._updateDOM();
    }
  }

  _state() {
    return this._hass?.states[this._config?.entity];
  }

  _resolveMode() {
    if (!this._hass || !this._config) return 'minimal';
    const compactWhen = this._config.compact_when;
    if (compactWhen && this._hass.states[compactWhen]?.state === 'on') {
      return 'minimal';
    }
    return this._state()?.attributes?.media_title ? 'media' : 'minimal';
  }

  _volPct() {
    if (this._localVol !== null) return this._localVol;
    return Math.round((this._state()?.attributes?.volume_level ?? 0) * 100);
  }

  _name() {
    return this._config.name
      ?? this._state()?.attributes?.friendly_name
      ?? this._config.entity;
  }

  // ─── DOM setup ────────────────────────────────────────────────────────────

  _setupDOM() {
    if (!this._config) return;
    const mode = this._currentMode ?? (this._currentMode = this._resolveMode());

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        * { box-sizing: border-box; }

        .card {
          background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
          border-radius: var(--ha-card-border-radius, 12px);
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI',
                        system-ui, sans-serif;
          -webkit-font-smoothing: antialiased;
          user-select: none;
          -webkit-user-select: none;
        }

        /* ── MEDIA MODE ─────────────────── */
        .top-area {
          display: flex;
          align-items: center;
          gap: 13px;
          padding: 14px 16px 12px;
        }

        .art {
          width: 52px;
          height: 52px;
          border-radius: 8px;
          flex-shrink: 0;
          background: color-mix(in srgb, var(--primary-text-color, #fff) 8%, transparent);
          background-size: cover;
          background-position: center;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .art svg { opacity: 0.25; }

        .info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .device-name {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: -0.15px;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .track-info {
          font-size: 12px;
          font-weight: 400;
          color: var(--secondary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ── MINIMAL MODE ───────────────── */
        .minimal-name {
          padding: 11px 16px 5px;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.3px;
          text-transform: uppercase;
          color: var(--secondary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ── VOLUME BAR ─────────────────── */
        .vol-bar {
          position: relative;
          height: 46px;
          cursor: pointer;
          touch-action: none;
        }

        .vol-bg {
          position: absolute;
          inset: 0;
          background: color-mix(in srgb, var(--primary-text-color, #fff) 6%, transparent);
        }

        .vol-fill {
          position: absolute;
          top: 0; left: 0; bottom: 0;
          width: 0%;
          background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--primary-color, #6750a4) 60%, #000) 0%,
            var(--primary-color, #6750a4) 100%
          );
          will-change: width;
        }

        .card:not(.dragging) .vol-fill {
          transition: width 0.15s ease;
        }

        .vol-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          padding: 0 14px;
          pointer-events: none;
        }

        .vol-value {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.2px;
          color: rgba(255, 255, 255, 0.8);
          text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
        }
      </style>

      <div class="card" id="card">
        ${mode === 'media' ? `
          <div class="top-area">
            <div class="art" id="art"></div>
            <div class="info">
              <span class="device-name" id="name"></span>
              <span class="track-info" id="track"></span>
            </div>
          </div>
        ` : `
          <div class="minimal-name" id="name"></div>
        `}
        <div class="vol-bar" id="vol-bar">
          <div class="vol-bg"></div>
          <div class="vol-fill" id="vol-fill"></div>
          <div class="vol-overlay">
            <span class="vol-value" id="vol-value"></span>
          </div>
        </div>
      </div>
    `;

    this._updateDOM();
    this._attachPointerEvents();
  }

  // ─── DOM updates ──────────────────────────────────────────────────────────

  _updateDOM() {
    if (!this._currentMode) return;
    const sr = this.shadowRoot;
    const attrs = this._state()?.attributes ?? {};
    const pct = this._volPct();

    const nameEl = sr.getElementById('name');
    if (nameEl) nameEl.textContent = this._name();

    const trackEl = sr.getElementById('track');
    if (trackEl) {
      trackEl.textContent = [attrs.media_title, attrs.media_artist]
        .filter(Boolean).join(' · ');
    }

    const artEl = sr.getElementById('art');
    if (artEl) {
      const pic = attrs.entity_picture;
      if (pic) {
        artEl.style.backgroundImage = `url('${pic}')`;
        artEl.innerHTML = '';
      } else {
        artEl.style.backgroundImage = '';
        artEl.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24"
            fill="var(--primary-text-color)">
          <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
        </svg>`;
      }
    }

    const fill = sr.getElementById('vol-fill');
    if (fill) fill.style.width = pct + '%';

    const valEl = sr.getElementById('vol-value');
    if (valEl) valEl.textContent = pct + '%';
  }

  // ─── Pointer events ───────────────────────────────────────────────────────

  _attachPointerEvents() {
    const volBar = this.shadowRoot.getElementById('vol-bar');
    const card = this.shadowRoot.getElementById('card');
    if (!volBar) return;

    volBar.addEventListener('pointerdown', e => {
      e.preventDefault();
      volBar.setPointerCapture(e.pointerId);

      const rect = volBar.getBoundingClientRect();
      const startX = e.clientX;
      this._isDragging = false;

      const onMove = ev => {
        if (!this._isDragging && Math.abs(ev.clientX - startX) > 4) {
          this._isDragging = true;
          card?.classList.add('dragging');
        }
        if (!this._isDragging) return;
        const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
        this._localVol = Math.round((x / rect.width) * 100);
        this._updateDOM();
      };

      const onUp = ev => {
        volBar.removeEventListener('pointermove', onMove);
        volBar.removeEventListener('pointerup', onUp);
        volBar.removeEventListener('pointercancel', onUp);
        card?.classList.remove('dragging');

        const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
        const pct = this._isDragging
          ? (this._localVol ?? 0)
          : Math.round((x / rect.width) * 100);

        this._localVol = pct;
        this._updateDOM();
        this._setVolume(pct / 100);
        this._startSuppressWindow();
        this._isDragging = false;
      };

      volBar.addEventListener('pointermove', onMove);
      volBar.addEventListener('pointerup', onUp);
      volBar.addEventListener('pointercancel', onUp);
    });
  }

  _startSuppressWindow() {
    this._suppressUntil = Date.now() + SUPPRESS_MS;
    setTimeout(() => {
      if (Date.now() >= this._suppressUntil && !this._isDragging) {
        this._localVol = null;
        this._updateDOM();
      }
    }, SUPPRESS_MS + 50);
  }

  _setVolume(level) {
    if (!this._hass) return;
    this._hass.callService('media_player', 'volume_set', {
      entity_id: this._config.entity,
      volume_level: level,
    });
  }

  getCardSize() {
    return this._currentMode === 'media' ? 3 : 2;
  }

  static getStubConfig() {
    return { entity: 'media_player.example' };
  }
}

customElements.define('media-bar-card', MediaBarCard);
window.customCards ??= [];
if (!window.customCards.some(c => c.type === 'media-bar-card')) {
  window.customCards.push({
    type: 'media-bar-card',
    name: 'Media Bar Card',
    description: 'Slim media player card with auto media/minimal modes',
  });
}
