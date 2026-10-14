// Collaboration + versioning UI: header button, side panel (People / Chat / Activity / Versions),
// invite-code + QR flow, relay rooms, follow, soft-lock warnings, sync play. Installed lazily by
// app.js; everything else in the app is untouched except store.history (local undo) and the views'
// collabGeom() (cursor overlay geometry).
import { h, clear } from '../ui/dom.js';
import { button, toast, modal, promptText, confirmDialog } from '../ui/components.js';
import { uid } from '../core/util.js';
import { CollabSession, MAX_PEERS } from './session.js';
import { RelaySignaling, BroadcastSignaling } from './signaling.js';
import { installOverlay } from './overlay.js';
import { qrSvg } from './qr.js';
import { diffProjects, summarizeDiff } from './diff.js';
import { LOCAL_FIELDS } from './bridge.js';
import { reconcileObject } from './reconcile.js';
import * as V from './versions.js';
import { saveLocal, ensureProjectId } from '../io/autosave.js';
import { downloadBlob, safeFileName, PROJECT_EXTENSION } from '../io/project-file.js';
import { DEFAULT_ICE_SERVERS } from './net.js';

const USERS_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8"/></svg>';
const LS = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };
const VIEW_LABEL = { arrange: 'Arrange', session: 'Scenes', rack: 'Step Rack', piano: 'Piano Roll', mixer: 'Mixer', code: 'Code', patch: 'Plugboard', setlist: 'Setlist' };
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const stop = (e) => e.stopPropagation();

export function installCollab(app) {
  const { store, ui, engine, actions } = app;
  if (!document.querySelector('link[data-collab]')) {
    document.head.appendChild(h('link', { rel: 'stylesheet', href: new URL('../../styles/collab.css', import.meta.url).href, dataset: { collab: '1' } }));
  }
  let name = LS.get('daw3-collab-name', '') || `Guest ${Math.floor(Math.random() * 90 + 10)}`;
  const session = new CollabSession(store, { name });
  const overlay = installOverlay(app, session);
  app.collab = { session, overlay, open: () => openPanel(), versions: V };

  // ---------------------------------------------------------------- header button + panel shell
  const badge = h('span.collab-badge.hidden');
  const headerBtn = h('button.icon-btn.collab-btn', { title: 'Collaborate & versions — invite people to edit this project live; save / compare / restore versions', html: USERS_SVG });
  headerBtn.appendChild(badge);
  headerBtn.addEventListener('click', () => (panel.classList.contains('open') ? closePanel() : openPanel()));
  const header = document.querySelector('.app-header');
  if (header) { const groups = header.querySelectorAll(':scope > .hgroup'); header.insertBefore(h('div.hgroup', headerBtn), groups[groups.length - 1] || null); }

  let tab = 'people';
  let unread = 0;
  const tabBtns = {};
  const body = h('div.collab-body');
  const statusDot = h('span.collab-dot');
  const panel = h('aside.collab-panel', { onkeydown: stop, onkeyup: stop },
    h('div.collab-head', statusDot, h('b', 'Collaborate'), h('div.spacer'), button('', () => closePanel(), { icon: 'x', cls: 'small', title: 'Close' })),
    h('div.collab-tabs', ['people', 'chat', 'activity', 'versions'].map((id) => {
      const b = h('button.collab-tab', { type: 'button' }, { people: 'People', chat: 'Chat', activity: 'Activity', versions: 'Versions' }[id]);
      b.addEventListener('click', () => { tab = id; if (id === 'chat') unread = 0; render(); });
      tabBtns[id] = b;
      return b;
    })),
    body);
  document.body.appendChild(panel);
  function openPanel() { panel.classList.add('open'); render(); }
  function closePanel() { panel.classList.remove('open'); }

  // transient UI state of the People tab
  const flow = { inviteCode: null, answerCode: null, joinText: '', answerText: '', busy: false, error: null, relayUrl: LS.get('daw3-collab-relay', 'ws://localhost:8787'), room: '' };

  function render() {
    for (const [id, b] of Object.entries(tabBtns)) b.classList.toggle('active', id === tab);
    tabBtns.chat.textContent = unread ? `Chat (${unread})` : 'Chat';
    const n = session.peers.size;
    badge.textContent = String(n + 1);
    badge.classList.toggle('hidden', !session.active);
    headerBtn.classList.toggle('on', session.active);
    statusDot.className = `collab-dot ${session.active ? (session.connectedCount() ? 'live' : 'wait') : ''}`;
    if (!panel.classList.contains('open')) return;
    const keepScroll = body.scrollTop;
    clear(body);
    if (tab === 'people') body.append(peopleTab());
    else if (tab === 'chat') body.append(chatTab());
    else if (tab === 'activity') body.append(activityTab());
    else body.append(versionsTab());
    if (tab !== 'chat') body.scrollTop = keepScroll;
  }
  let rq = 0;
  const rerender = () => { if (!rq) rq = requestAnimationFrame(() => { rq = 0; render(); }); };
  for (const ev of ['peers', 'status', 'activity', 'follow', 'joined', 'sample']) session.on(ev, rerender);
  session.on('presence', () => { if (tab === 'people') rerender(); });
  session.on('tick', () => { if (tab === 'people') rerender(); });
  session.on('chat', (m) => { if (!(tab === 'chat' && panel.classList.contains('open')) && !m.mine) { unread++; toast(`${m.name}: ${m.text.slice(0, 80)}`); } rerender(); });
  session.on('joined', () => {
    flow.answerCode = null;
    const first = store.get().tracks[0];
    ui.set({ selectedTrackId: first?.id || null, selectedPatternId: first?.activePatternId || null, selectedClipIds: [] });
    toast(`Joined "${store.get().name}" — edits now sync live`, { level: 'success' });
  });
  session.on('link-open', (id) => { const p = session.peers.get(id); toast(`${p?.name || 'Someone'} connected`, { level: 'success' }); });

  // soft locks: warn (don't block) when you edit a track someone else is working on
  const warned = new Map();
  session.on('lock-conflict', (list) => {
    for (const { peer, trackId } of list) {
      const k = peer.id + trackId;
      if (Date.now() - (warned.get(k) || 0) < 10000) continue;
      warned.set(k, Date.now());
      const t = store.get().tracks.find((x) => x.id === trackId);
      toast(`${peer.name} is editing ${t?.name || 'this track'} — your change went through; maybe coordinate in Chat`, { level: 'warn', timeout: 4500 });
    }
  });

  // ---------------------------------------------------------------- sync play (transport stays local by default)
  let shareTransport = false, followTransport = false, applyingTransport = false;
  engine.on?.('state', ({ playing }) => {
    if (shareTransport && session.active && !applyingTransport) session.sendTransport(playing, engine.getPosition?.() || 0, store.get().bpm);
  });
  session.on('transport', async (t) => {
    if (!followTransport) return;
    applyingTransport = true;
    try {
      if (t.playing) { actions.setPosition(t.beat); await actions.play(); } else actions.stop();
    } finally { setTimeout(() => { applyingTransport = false; }, 50); }
  });

  // ---------------------------------------------------------------- People tab
  const section = (title, ...kids) => h('section.collab-sec', h('h4', title), ...kids);
  const codeBox = (code, label) => {
    const ta = h('textarea.collab-code', { readOnly: true, rows: 4, onkeydown: stop }, code);
    const link = `${location.origin}${location.pathname}#join=${code}`;
    let qr = null;
    try { qr = h('div.collab-qr', { html: qrSvg(link, { scale: 2 }), title: 'Scan to open daW³ with this code filled in' }); } catch { /* too long for a QR */ }
    return h('div.collab-codebox', h('div.collab-hint', label), ta,
      h('div.collab-row',
        button('Copy code', async () => { try { await navigator.clipboard.writeText(code); toast('Copied'); } catch { ta.select(); document.execCommand?.('copy'); } }, { icon: 'copy', cls: 'small' }),
        button('Copy link', async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { /* ignore */ } }, { cls: 'small' })),
      qr);
  };
  const busy = async (fn) => {
    flow.busy = true; flow.error = null; render();
    try { await fn(); } catch (e) { console.warn('[collab]', e); flow.error = e.message; }
    flow.busy = false; render();
  };

  function nameField() {
    const inp = h('input.collab-input', { type: 'text', value: session.name, maxLength: 40, onkeydown: stop, title: 'Your name as others see it' });
    inp.addEventListener('change', () => { session.rename(inp.value); LS.set('daw3-collab-name', session.name); });
    return h('div.collab-row', h('span.collab-swatch', { style: { background: session.color } }), inp);
  }

  function peopleTab() {
    const wrap = h('div');
    wrap.append(nameField());
    if (flow.error) wrap.append(h('div.collab-error', flow.error));
    if (flow.busy) wrap.append(h('div.collab-hint', 'Working… (gathering network routes can take a few seconds)'));
    if (!session.active) {
      wrap.append(
        section('Start a session',
          h('p.collab-hint', 'Share this project live. Each person you invite gets a one-time code: send it any way you like (chat, email, QR); they send an answer code back. Peer-to-peer — nothing is uploaded.'),
          button('Start & create invite code', () => busy(async () => { flow.inviteCode = await session.createInvite(); }), { icon: 'plus', primary: true })),
        section('Join with a code',
          joinBox()),
        relaySection());
      if (flow.answerCode) wrap.append(section('Send this answer back', codeBox(flow.answerCode, 'Give this answer code to the person who invited you. You are connected once they paste it.')));
      return wrap;
    }
    // active session
    const me = { id: session.id, name: `${session.name} (you)`, color: session.color, presence: session.presence };
    const peers = [me, ...session.peers.values()];
    const following = overlay.following();
    const tracks = store.get().tracks;
    const tname = (id) => tracks.find((t) => t.id === id)?.name;
    wrap.append(section(`In this session (${peers.length}/${MAX_PEERS})`,
      h('ul.collab-people', peers.map((p) => {
        const pr = p.presence || {};
        const where = [VIEW_LABEL[pr.view] || null, tname(pr.trackId) ? `on ${tname(pr.trackId)}` : null].filter(Boolean).join(' · ');
        const direct = p.id === session.id || session.links.get(p.id)?.open;
        return h('li', h('span.collab-swatch', { style: { background: p.color } }),
          h('div.collab-person', h('b', p.name), h('small', where || (direct ? 'connected' : 'via host'))),
          p.id === session.id ? null : button(following === p.id ? 'Unfollow' : 'Follow', () => { overlay.follow(following === p.id ? null : p.id); render(); }, { cls: 'small', title: 'Follow their view, selection and scroll position' }));
      }))));
    const locks = session.locks();
    if (locks.length) wrap.append(section('Being edited', h('ul.collab-locks', locks.map(({ peer, trackId }) => h('li', h('span.collab-swatch', { style: { background: peer.color } }), `${peer.name} is editing ${tname(trackId) || 'a track'}`)))));
    wrap.append(section('Invite someone',
      flow.inviteCode
        ? h('div', codeBox(flow.inviteCode, '1. Send this invite code to one person.'), answerBox())
        : button('Create invite code', () => busy(async () => { flow.inviteCode = await session.createInvite(); }), { icon: 'plus', cls: 'small' })));
    if (flow.answerCode) wrap.append(section('Send this answer back', codeBox(flow.answerCode, 'Give this to the host.')));
    const shareT = h('input', { type: 'checkbox', checked: shareTransport });
    shareT.addEventListener('change', () => { shareTransport = shareT.checked; });
    const followT = h('input', { type: 'checkbox', checked: followTransport });
    followT.addEventListener('change', () => { followTransport = followT.checked; });
    wrap.append(section('Playback',
      h('p.collab-hint', 'Play / stop is local to each person. Optionally:'),
      h('label.collab-check', shareT, ' Broadcast my play / stop (sync play)'),
      h('label.collab-check', followT, ' Follow others’ play / stop')));
    wrap.append(h('div.collab-row', button('Leave session', async () => {
      if (await confirmDialog('Leave session', 'Stop sharing? You keep your copy of the project.')) { session.leave(); flow.inviteCode = null; flow.answerCode = null; toast('Left the session'); }
    }, { cls: 'small danger' })));
    wrap.append(iceSection());
    return wrap;
  }

  function joinBox() {
    const ta = h('textarea.collab-code', { rows: 3, placeholder: 'daw3:…', onkeydown: stop });
    ta.value = flow.joinText;
    ta.addEventListener('input', () => { flow.joinText = ta.value; });
    return h('div', ta, h('div.collab-row', button('Join', () => busy(async () => {
      if (store.get().tracks.length) await saveLocal(store.get()).catch(() => {}); // your current project stays in Recent
      flow.answerCode = await session.acceptInvite(flow.joinText);
      flow.joinText = '';
    }), { primary: true, cls: 'small' }), h('span.collab-hint', 'Your current project is kept in Recent; the session’s project opens.')));
  }

  function answerBox() {
    const ta = h('textarea.collab-code', { rows: 3, placeholder: '2. Paste their answer code here', onkeydown: stop });
    ta.value = flow.answerText;
    ta.addEventListener('input', () => { flow.answerText = ta.value; });
    return h('div', ta, h('div.collab-row', button('Connect', () => busy(async () => {
      await session.acceptAnswer(flow.answerText);
      flow.answerText = '';
      flow.inviteCode = null;
    }), { primary: true, cls: 'small' })));
  }

  function relaySection() {
    const url = h('input.collab-input', { type: 'text', value: flow.relayUrl, placeholder: 'wss://your-relay.example', onkeydown: stop });
    const room = h('input.collab-input', { type: 'text', value: flow.room, placeholder: 'room name', onkeydown: stop });
    url.addEventListener('change', () => { flow.relayUrl = url.value.trim(); LS.set('daw3-collab-relay', flow.relayUrl); });
    room.addEventListener('input', () => { flow.room = room.value.trim(); });
    const adapter = () => (flow.relayUrl === 'local' ? new BroadcastSignaling() : new RelaySignaling(flow.relayUrl));
    const go = (host) => busy(async () => {
      if (!flow.room) flow.room = uid('room').slice(5);
      if (!host && store.get().tracks.length) await saveLocal(store.get()).catch(() => {});
      await session.joinRoom(adapter(), flow.room, { host });
      toast(host ? `Room "${flow.room}" open — others join with the same relay + room` : `Waiting for the room "${flow.room}"…`);
    });
    return h('details.collab-sec', h('summary', 'Use a relay server (optional)'),
      h('p.collab-hint', 'With a tiny relay (tools/collab-relay, deploy anywhere) people join by room name — no code exchange, full mesh. Enter “local” to connect tabs of this browser without any server.'),
      url, room,
      h('div.collab-row', button('Host room', () => go(true), { cls: 'small primary' }), button('Join room', () => go(false), { cls: 'small' })));
  }

  function iceSection() {
    const ta = h('textarea.collab-code', { rows: 3, onkeydown: stop, placeholder: '[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' });
    ta.value = LS.get('daw3-collab-ice', '');
    return h('details.collab-sec', h('summary', 'Network (STUN / TURN)'),
      h('p.collab-hint', `Uses public STUN (${DEFAULT_ICE_SERVERS[0].urls}). If people cannot connect (strict / corporate NAT), add a TURN server here (applies to new connections).`),
      ta, button('Save', () => {
        const v = ta.value.trim();
        if (v) { try { if (!Array.isArray(JSON.parse(v))) throw new Error('expected an array'); } catch (e) { toast('Invalid JSON: ' + e.message, { level: 'error' }); return; } }
        LS.set('daw3-collab-ice', v); toast('Saved');
      }, { cls: 'small' }));
  }

  // ---------------------------------------------------------------- Chat / Activity
  function chatTab() {
    const list = h('div.collab-chat', session.chat.length ? session.chat.map((m) => h('div.collab-msg', { class: m.mine ? 'mine' : '' },
      h('span.collab-swatch', { style: { background: m.color } }), h('b', m.name), h('small', time(m.at)), h('div', m.text))) : h('p.collab-hint', session.active ? 'No messages yet.' : 'Start or join a session to chat.'));
    const inp = h('input.collab-input', { type: 'text', placeholder: 'Message…', disabled: !session.active, onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { session.sendChat(inp.value); inp.value = ''; } } });
    setTimeout(() => { list.scrollTop = list.scrollHeight; if (session.active) inp.focus(); }, 0);
    return h('div.collab-chatwrap', list, inp);
  }

  function activityTab() {
    const tracks = store.get().tracks;
    const items = [...session.activity].reverse();
    if (!items.length) return h('p.collab-hint', 'Edits, joins and leaves show up here.');
    return h('ul.collab-feed', items.map((a) => h('li', h('span.collab-swatch', { style: { background: a.color } }),
      h('div', h('b', a.name), ' ', a.what, a.count > 1 ? ` ×${a.count}` : '',
        a.tracks?.length ? h('small', ` · ${a.tracks.map((id) => tracks.find((t) => t.id === id)?.name).filter(Boolean).join(', ')}`) : null),
      h('small.collab-time', time(a.at)))));
  }

  // ---------------------------------------------------------------- Versions
  let versionList = null;
  async function refreshVersions() {
    try { versionList = await V.listVersions(store.get().id); } catch (e) { versionList = []; console.warn(e); }
    if (tab === 'versions') render();
  }
  store.on('load', (p) => {
    const imported = V.takeImportedVersions(p);
    if (imported.length) V.putVersions(imported).then(() => { toast(`${imported.length} version(s) imported with the project`); refreshVersions(); }).catch(() => {});
    else refreshVersions();
  });

  function ensureId() {
    if (!store.get().id) store.transact('Project id', (p) => { ensureProjectId(p); }, { undo: false });
    return store.get().id;
  }

  async function saveVersionPrompt() {
    const name = await promptText('Save version', `Version ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
    if (!name) return;
    ensureId();
    await V.saveVersion(store.get(), name, { author: session.name });
    toast(`Saved version "${name}"`, { level: 'success' });
    refreshVersions();
  }

  async function duplicateAsAlternative() {
    if (session.active && !(await confirmDialog('Duplicate as alternative', 'The alternative opens as a separate project, so you will leave the live session. Continue?'))) return;
    if (session.active) session.leave();
    const cur = store.get();
    ensureId();
    const base = await V.saveVersion(cur, 'Branch point', { author: session.name });
    await saveLocal(cur).catch(() => {});
    const alt = JSON.parse(JSON.stringify(cur));
    alt.id = uid('prj');
    alt.name = `${cur.name} (alt)`;
    const history = await V.listVersions(cur.id);
    await V.putVersions(history.map((v) => ({ ...v, id: uid('ver'), projectId: alt.id, parentId: v.id === base.id ? base.id : v.parentId })));
    actions.loadProjectObject(alt, 'Alternative');
    await saveLocal(store.get()).catch(() => {});
    refreshVersions();
  }

  async function exportVersions() {
    ensureId();
    const p = await V.exportWithVersions(store.get());
    downloadBlob(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${safeFileName(p.name)}${PROJECT_EXTENSION}`);
    toast(`Downloaded with ${p.versions.length} version(s)`);
  }

  function restore(v) {
    const snap = V.hydrateSnapshot(v.json, store.get());
    const skip = new Set([...LOCAL_FIELDS, 'id']);
    store.transact(`Restore "${v.name}"`, (p) => {
      for (const k of skip) { if (k in p) snap[k] = p[k]; else delete snap[k]; }
      reconcileObject(p, snap);
    });
    toast(`Restored "${v.name}" — Ctrl+Z to undo${session.active ? ' (shared with everyone in the session)' : ''}`, { level: 'success' });
  }

  function showDiff(v) {
    const from = JSON.parse(v.json);
    const others = (versionList || []).filter((x) => x.id !== v.id);
    const sel = h('select.collab-input', h('option', { value: '' }, 'Current project'), others.map((o) => h('option', { value: o.id }, o.name)));
    const out = h('div.collab-diff');
    const show = () => {
      const other = others.find((o) => o.id === sel.value);
      const to = other ? JSON.parse(other.json) : JSON.parse(V.snapshotJson(store.get()));
      const d = diffProjects(from, to);
      clear(out);
      out.append(h('p', h('b', summarizeDiff(d))));
      const fmt = (x) => (x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x).slice(0, 60) : String(x));
      if (d.project.length) out.append(h('h4', 'Song'), h('ul', d.project.map((c) => h('li', `${c.key}: ${fmt(c.from)} → ${fmt(c.to)}`))));
      for (const [k, title] of [['tracks', 'Tracks'], ['clips', 'Clips'], ['patterns', 'Patterns'], ['buses', 'Buses'], ['markers', 'Markers'], ['samples', 'Samples']]) {
        const g = d[k];
        if (!g.added.length && !g.removed.length && !g.changed.length) continue;
        out.append(h('h4', title), h('ul',
          g.added.map((x) => h('li.add', `+ ${x.name}`)),
          g.removed.map((x) => h('li.del', `− ${x.name}`)),
          g.changed.map((x) => h('li.chg', `~ ${x.name}: `, [
            ...(x.fields || []).slice(0, 6).map((f) => `${f.key} ${fmt(f.from)} → ${fmt(f.to)}`),
            x.notes ? `notes +${x.notes.added} −${x.notes.removed} ~${x.notes.changed}` : null,
          ].filter(Boolean).join('; ') + ((x.fields || []).length > 6 ? ' …' : '')))));
      }
    };
    sel.addEventListener('change', show);
    show();
    modal({ title: `Changes since "${v.name}"`, body: h('div', h('div.collab-row', h('span', 'Compare with'), sel), out), width: 620, actions: [{ label: 'Restore this version', onClick: () => restore(v) }, { label: 'Close', primary: true }] });
  }

  function versionsTab() {
    if (!versionList) refreshVersions();
    const list = versionList || [];
    return h('div',
      h('div.collab-row.wrap',
        button('Save version…', () => saveVersionPrompt(), { icon: 'save', primary: true, cls: 'small' }),
        button('Duplicate as alternative', () => duplicateAsAlternative(), { icon: 'copy', cls: 'small', title: 'Branch: keep this project and continue in a copy (with its version history)' }),
        button('Download with versions', () => exportVersions(), { icon: 'download', cls: 'small', title: 'A .daW3 file that also carries the saved versions' })),
      V.isVersioningAvailable() ? null : h('p.collab-error', 'IndexedDB is not available — versions cannot be stored in this browser.'),
      list.length ? h('ul.collab-versions', list.map((v) => h('li',
        h('div', h('b', v.name), h('small', `${new Date(v.createdAt).toLocaleString()}${v.author ? ' · ' + v.author : ''}`)),
        h('div.collab-row',
          button('Diff', () => showDiff(v), { cls: 'small', title: 'What changed between this version and now (or another version)' }),
          button('Restore', async () => { if (await confirmDialog('Restore version', `Replace the current project content with "${v.name}"? (Undoable)`)) restore(v); }, { cls: 'small' }),
          button('', async () => { if (await confirmDialog('Delete version', `Delete "${v.name}"?`)) { await V.deleteVersion(v.id); refreshVersions(); } }, { icon: 'trash', cls: 'small', title: 'Delete version' })))))
        : h('p.collab-hint', 'No versions yet. Save one before big changes; restore or compare any time.'));
  }

  // ---------------------------------------------------------------- menu entries + join links
  const baseMenu = actions.mainMenuItems;
  actions.mainMenuItems = () => {
    const items = baseMenu();
    const i = items.findIndex((x) => x && x.label && x.label.startsWith('Rename project'));
    items.splice(i >= 0 ? i + 1 : items.length, 0,
      { label: 'Collaborate (live session)…', icon: 'sparkles', onClick: () => { tab = 'people'; openPanel(); } },
      { label: 'Save version…', icon: 'layers', onClick: () => saveVersionPrompt() },
      { label: 'Versions & history…', icon: 'layers', onClick: () => { tab = 'versions'; openPanel(); } });
    return items;
  };
  const m = /^#join=(.+)$/.exec(location.hash || '');
  if (m) {
    flow.joinText = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => { tab = 'people'; openPanel(); toast('Invite code filled in — press Join'); }, 500);
  }
  window.addEventListener('beforeunload', () => { if (session.active) session.broadcast({ type: 'bye' }); });
  render();
  return app.collab;
}
