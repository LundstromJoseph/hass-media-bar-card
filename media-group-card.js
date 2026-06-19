'use strict';

// Slim, generic multi-speaker card. Manages a *pool* of any grouping-capable
// media_player entities: shows a group when speakers are joined, individual
// rows when they're not, and a checklist editor to change membership.
// Grouping uses only the standard HA model (group_members + media_player.join/
// unjoin), so it isn't tied to any one integration. The audio_pro
// `multiroom_role` / `group_master` attributes are used as hints when present.

const SUPPRESS_MS = 2000;
const GROUPING = 524288; // MediaPlayerEntityFeature.GROUPING

class MediaGroupCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._localVols = {};     // entity_id -> pct, while dragging/suppressed
    this._suppressUntil = 0;
    this._isDragging = false;
    this._expanded = false;   // group row expanded to per-member sliders
    this._editorOpen = false; // membership checklist visible
    this._sig = null;
  }

  setConfig(config) {
    const entities = config.entities ?? (config.entity ? [config.entity] : null);
    if (!entities || !entities.length) {
      throw new Error('media-group-card: `entities` (or `entity`) is required');
    }
    this._config = { ...config, entities };
    this._sig = null;
    this.shadowRoot.innerHTML = '';
  }

  set hass(hass) {
    this._hass = hass;
    if (this._isDragging || Date.now() < this._suppressUntil) return;
    this._localVols = {};
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    } else {
      this._updateVolumes();
    }
  }

  // ─── model helpers ──────────────────────────────────────────────────────

  _ids() { return this._config.entities; }
  _st(id) { return this._hass?.states[id]; }

  _name(id) {
    return this._config.names?.[id]
      ?? this._st(id)?.attributes?.friendly_name
      ?? id;
  }

  _supportsGrouping(id) {
    const f = this._st(id)?.attributes?.supported_features ?? 0;
    return (f & GROUPING) === GROUPING;
  }

  _volPct(id) {
    if (this._localVols[id] != null) return this._localVols[id];
    return Math.round((this._st(id)?.attributes?.volume_level ?? 0) * 100);
  }

  _members(id) {
    const gm = this._st(id)?.attributes?.group_members;
    return Array.isArray(gm) ? gm : [];
  }

  _isGrouped(id) {
    return this._members(id).length > 1;
  }

  // The single primary group within the pool (members in config order), or null.
  _group() {
    const pool = this._ids();
    const grouped = pool.filter(id => this._isGrouped(id));
    if (!grouped.length) return null;
    const set = new Set();
    grouped.forEach(id => this._members(id).forEach(m => {
      if (pool.includes(m)) set.add(m);
    }));
    const members = pool.filter(id => set.has(id));
    if (members.length < 2) return null;
    return { members, master: this._master(members) };
  }

  _master(members) {
    for (const id of members) {
      const gm = this._st(id)?.attributes?.group_master;
      if (gm && members.includes(gm)) return gm;
    }
    const playing = members.find(id => this._st(id)?.state === 'playing');
    return playing ?? members[0];
  }

  _preferredMaster(desired) {
    const g = this._group();
    if (g && desired.includes(g.master)) return g.master;
    const playing = desired.find(id => this._st(id)?.state === 'playing');
    return playing ?? desired[0];
  }

  _signature() {
    const sig = this._ids().map(id => {
      const s = this._st(id);
      if (!s) return id + ':NA';
      return id + ':' + (this._members(id).join('+') || 'solo')
        + ':' + (s.attributes.media_title ? 'm' : '-')
        + ':' + s.state;
    }).join('|');
    return sig + '#exp=' + this._expanded + '#ed=' + this._editorOpen;
  }

  // ─── service calls ──────────────────────────────────────────────────────

  _setVolume(ids, level) {
    ids.forEach(id => this._hass.callService('media_player', 'volume_set', {
      entity_id: id,
      volume_level: level,
    }));
  }

  _join(master, members) {
    if (!members.length) return;
    this._hass.callService('media_player', 'join', {
      entity_id: master,
      group_members: members,
    });
  }

  _unjoin(ids) {
    (Array.isArray(ids) ? ids : [ids]).forEach(id =>
      this._hass.callService('media_player', 'unjoin', { entity_id: id }));
  }

  // Declarative: make exactly `desired` play together (or ungroup if <2).
  _reconcile(desired) {
    const g = this._group();
    const current = g ? g.members : [];
    if (desired.length >= 2) {
      const master = this._preferredMaster(desired);
      const alreadyOk = (g && g.master === master) ? new Set(g.members) : new Set([master]);
      const toJoin = desired.filter(id => id !== master && !alreadyOk.has(id));
      const toRemove = current.filter(id => !desired.includes(id));
      if (toRemove.length) this._unjoin(toRemove);
      this._join(master, toJoin);
    } else {
      if (current.length) this._unjoin(current);
    }
    this._startSuppress();
  }

  _toggleMember(id, checked) {
    const g = this._group();
    let desired = g ? [...g.members] : [];
    if (checked) {
      if (!desired.includes(id)) desired.push(id);
    } else {
      desired = desired.filter(x => x !== id);
    }
    desired = this._ids().filter(x => desired.includes(x));
    this._reconcile(desired);
  }

  // ─── render ─────────────────────────────────────────────────────────────

  _render() {
    if (!this._config || !this._hass) return;
    const group = this._group();
    const grouped = group ? group.members : [];
    const solos = this._ids().filter(id => !grouped.includes(id));

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="card">
        ${this._config.title ? `<div class="card-title">${esc(this._config.title)}</div>` : ''}
        ${group ? this._groupHtml(group) : ''}
        ${solos.map(id => this._soloHtml(id, !!group)).join('')}
        ${this._editorOpen ? this._editorHtml(group) : ''}
      </div>
    `;
    this._attach();
    this._updateVolumes();
    this._sig = this._signature();
  }

  _groupHtml(group) {
    const { master, members } = group;
    const a = this._st(master)?.attributes ?? {};
    const sub = [a.media_title, a.media_artist].filter(Boolean).join(' · ')
      || `${members.length} speakers`;
    return `
      <div class="row group">
        <div class="head">
          ${artHtml(a.entity_picture)}
          <div class="info">
            <span class="title">${esc(this._name(master))} · ${esc(this._config.group_label ?? 'Grouped')}</span>
            <span class="sub">${esc(sub)}</span>
          </div>
          <button class="icon-btn" data-act="edit" title="Edit group">${ICON.link}</button>
          <button class="icon-btn" data-act="expand" title="Per-speaker volume">
            ${this._expanded ? ICON.chevUp : ICON.chevDown}
          </button>
        </div>
        ${volBarHtml(master, members)}
        ${this._expanded ? `
          <div class="members">
            ${members.map(id => `
              <div class="member">
                <div class="member-head">
                  <span class="member-name">${esc(this._name(id))}${id === master ? ' · master' : ''}</span>
                  <button class="icon-btn sm" data-act="${id === master ? 'dissolve' : 'leave'}" data-id="${id}"
                          title="${id === master ? 'Ungroup all' : 'Remove from group'}">${ICON.unlink}</button>
                </div>
                ${volBarHtml(id, [id], true)}
              </div>`).join('')}
          </div>` : ''}
      </div>
    `;
  }

  _soloHtml(id, groupExists) {
    const a = this._st(id)?.attributes ?? {};
    const hasMedia = !!a.media_title;
    const sub = [a.media_title, a.media_artist].filter(Boolean).join(' · ');
    return `
      <div class="row solo">
        <div class="head">
          ${hasMedia ? artHtml(a.entity_picture) : ''}
          <div class="info">
            <span class="${hasMedia ? 'title' : 'name-only'}">${esc(this._name(id))}</span>
            ${hasMedia ? `<span class="sub">${esc(sub)}</span>` : ''}
          </div>
          ${this._supportsGrouping(id) ? `
            <button class="icon-btn" data-act="${groupExists ? 'add' : 'edit'}" data-id="${id}"
                    title="${groupExists ? 'Add to group' : 'Group speakers'}">${ICON.link}</button>` : ''}
        </div>
        ${volBarHtml(id, [id])}
      </div>
    `;
  }

  _editorHtml(group) {
    const members = group ? group.members : [];
    const rows = this._ids().filter(id => this._supportsGrouping(id)).map(id => `
      <label class="edit-row">
        <input type="checkbox" data-id="${id}" ${members.includes(id) ? 'checked' : ''}/>
        <span>${esc(this._name(id))}</span>
      </label>`).join('');
    return `
      <div class="editor">
        <div class="editor-title">Play together</div>
        ${rows}
      </div>
    `;
  }

  // ─── events ─────────────────────────────────────────────────────────────

  _attach() {
    const sr = this.shadowRoot;
    sr.querySelectorAll('.vol-bar').forEach(bar => this._wireVolBar(bar));

    sr.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        if (act === 'expand') { this._expanded = !this._expanded; this._render(); }
        else if (act === 'edit') { this._editorOpen = !this._editorOpen; this._render(); }
        else if (act === 'leave') this._unjoin(id);
        else if (act === 'dissolve') { const g = this._group(); if (g) this._unjoin(g.members); }
        else if (act === 'add') { const g = this._group(); if (g) this._join(g.master, [id]); }
      });
    });

    sr.querySelectorAll('.edit-row input').forEach(cb => {
      cb.addEventListener('change', () => this._toggleMember(cb.dataset.id, cb.checked));
    });
  }

  _wireVolBar(bar) {
    const display = bar.dataset.display;
    const targets = bar.dataset.targets.split(',');
    bar.addEventListener('pointerdown', e => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const rect = bar.getBoundingClientRect();
      const startX = e.clientX;
      let moved = false;

      const onMove = ev => {
        if (!moved && Math.abs(ev.clientX - startX) > 4) { moved = true; this._isDragging = true; bar.classList.add('dragging'); }
        if (!moved) return;
        const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
        this._localVols[display] = Math.round((x / rect.width) * 100);
        this._paintBar(bar, this._localVols[display]);
      };
      const onUp = ev => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onUp);
        bar.classList.remove('dragging');
        const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
        const pct = moved ? (this._localVols[display] ?? 0) : Math.round((x / rect.width) * 100);
        this._localVols[display] = pct;
        this._paintBar(bar, pct);
        this._setVolume(targets, pct / 100);
        this._startSuppress();
        this._isDragging = false;
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    });
  }

  _startSuppress() {
    this._suppressUntil = Date.now() + SUPPRESS_MS;
    setTimeout(() => {
      if (Date.now() >= this._suppressUntil && !this._isDragging) {
        this._localVols = {};
        this._sig = null;
        if (this._hass) this.hass = this._hass;
      }
    }, SUPPRESS_MS + 50);
  }

  _paintBar(bar, pct) {
    const fill = bar.querySelector('.vol-fill');
    const val = bar.querySelector('.vol-value');
    if (fill) fill.style.width = pct + '%';
    if (val) val.textContent = pct + '%';
  }

  _updateVolumes() {
    this.shadowRoot.querySelectorAll('.vol-bar').forEach(bar => {
      this._paintBar(bar, this._volPct(bar.dataset.display));
    });
  }

  getCardSize() {
    const g = this._group();
    return (g ? 2 : 0) + this._ids().length;
  }

  static getStubConfig() {
    return { entities: ['media_player.example_1', 'media_player.example_2'] };
  }
}

// ─── markup helpers ─────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function artHtml(pic) {
  return pic
    ? `<div class="art" style="background-image:url('${esc(pic)}')"></div>`
    : `<div class="art"><svg width="24" height="24" viewBox="0 0 24 24" fill="var(--primary-text-color)">
         <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>`;
}

function volBarHtml(display, targets, small) {
  return `
    <div class="vol-bar${small ? ' sm' : ''}" data-display="${display}" data-targets="${targets.join(',')}">
      <div class="vol-bg"></div>
      <div class="vol-fill"></div>
      <div class="vol-overlay"><span class="vol-value"></span></div>
    </div>`;
}

const ICON = {
  link: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7h-4a5 5 0 0 0 0 10h4v-1.9h-4A3.1 3.1 0 0 1 3.9 12m4.1 1h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17 7h-4v1.9h4a3.1 3.1 0 0 1 .9 6.06l1.4 1.4A5 5 0 0 0 17 7m-1 4h-2.2l2 2H16zm-13.74-.74L3.5 11.5A3.1 3.1 0 0 0 7 17h4v-1.9H7a3.1 3.1 0 0 1-2.66-4.66L2.26 10.26M1.39 2.86l1.41-1.41 19.74 19.74-1.41 1.41z"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>',
  chevUp: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg>',
};

const STYLES = `
  :host { display: block; }
  * { box-sizing: border-box; }
  .card {
    background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
    border-radius: var(--ha-card-border-radius, 12px);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none; -webkit-user-select: none;
  }
  .card-title { padding: 12px 16px 4px; font-size: 12px; font-weight: 600;
    letter-spacing: .3px; text-transform: uppercase; color: var(--secondary-text-color); }
  .row + .row { border-top: 1px solid color-mix(in srgb, var(--primary-text-color, #fff) 7%, transparent); }
  .row.group { background: color-mix(in srgb, var(--primary-color, #6750a4) 8%, transparent); }
  .head { display: flex; align-items: center; gap: 12px; padding: 12px 12px 10px 16px; }
  .art { width: 44px; height: 44px; border-radius: 8px; flex-shrink: 0;
    background: color-mix(in srgb, var(--primary-text-color, #fff) 8%, transparent);
    background-size: cover; background-position: center; display: flex; align-items: center; justify-content: center; }
  .art svg { opacity: .25; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 13px; font-weight: 600; letter-spacing: -.15px; color: var(--primary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name-only { font-size: 12px; font-weight: 600; letter-spacing: .3px; text-transform: uppercase;
    color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 12px; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icon-btn { background: none; border: none; padding: 6px; margin: 0; cursor: pointer; border-radius: 8px;
    color: var(--secondary-text-color); display: flex; align-items: center; justify-content: center; }
  .icon-btn:hover { background: color-mix(in srgb, var(--primary-text-color, #fff) 10%, transparent);
    color: var(--primary-text-color); }
  .icon-btn.sm { padding: 4px; }
  .vol-bar { position: relative; height: 44px; cursor: pointer; touch-action: none; }
  .vol-bar.sm { height: 34px; }
  .vol-bg { position: absolute; inset: 0; background: color-mix(in srgb, var(--primary-text-color, #fff) 6%, transparent); }
  .vol-fill { position: absolute; top: 0; left: 0; bottom: 0; width: 0%;
    background: linear-gradient(90deg, color-mix(in srgb, var(--primary-color, #6750a4) 60%, #000) 0%, var(--primary-color, #6750a4) 100%);
    will-change: width; }
  .vol-bar:not(.dragging) .vol-fill { transition: width .15s ease; }
  .vol-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: flex-end;
    padding: 0 14px; pointer-events: none; }
  .vol-value { font-size: 12px; font-weight: 600; letter-spacing: .2px; color: rgba(255,255,255,.8);
    text-shadow: 0 1px 4px rgba(0,0,0,.6); }
  .members { padding: 0 0 8px; }
  .member { padding: 0 8px 0 16px; }
  .member-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 4px 2px 0; }
  .member-name { font-size: 12px; color: var(--secondary-text-color); }
  .editor { padding: 8px 16px 14px; border-top: 1px solid color-mix(in srgb, var(--primary-text-color, #fff) 7%, transparent); }
  .editor-title { font-size: 11px; font-weight: 600; letter-spacing: .3px; text-transform: uppercase;
    color: var(--secondary-text-color); padding-bottom: 6px; }
  .edit-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 14px;
    color: var(--primary-text-color); cursor: pointer; }
  .edit-row input { width: 18px; height: 18px; accent-color: var(--primary-color, #6750a4); }
`;

customElements.define('media-group-card', MediaGroupCard);
window.customCards ??= [];
if (!window.customCards.some(c => c.type === 'media-group-card')) {
  window.customCards.push({
    type: 'media-group-card',
    name: 'Media Group Card',
    description: 'Slim multi-speaker card with native grouping (group view, per-speaker volume, membership editor)',
  });
}
