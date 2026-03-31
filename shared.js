function createDb() {
  return supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    realtime: {
      params: { eventsPerSecond: 10 },
      heartbeatIntervalMs: 2500,
      timeout: 3000
    }
  });
}

const html = htm.bind(React.createElement);

// ============================================================
// Constants
// ============================================================

const TIME_OPTIONS = ['', 'Walk-in'];
for (let h = 1; h <= 5; h++) {
  for (let m = 0; m < 60; m += 15) {
    TIME_OPTIONS.push(`${h}:${String(m).padStart(2, '0')}PM`);
  }
}

const STATUS_OPTIONS = ['', 'Checked-in', 'Shopping'];

const EMPTY_NEW = { name_first: '', name_last: '', appt_time: '', status: 'Checked-in' };

function statusClass(s) {
  if (!s) return '';
  return 'status-' + s.toLowerCase().replace(/[^a-z]/g, '-');
}

/** 
 * Helper to capitalize first letter and lowercase the rest 
 */
function formatNameInput(str) {
  if (!str) return null;
  const s = str.trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ============================================================
// Hooks
// ============================================================

function useConnected() {
  const [connected, setConnected] = React.useState(true);
  const reconnectedRef = React.useRef(false);

  const makeSubscribeCallback = React.useCallback((fetchAll) => {
    return function(status) {
      const live = status === 'SUBSCRIBED';
      setConnected(live);
      if (live) {
        if (reconnectedRef.current) fetchAll();
        reconnectedRef.current = true;
      }
    };
  }, []);

  return { connected, setConnected, makeSubscribeCallback };
}

function useRealtimeClients(db, channelName) {
  const [clients, setClients] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [settings, setSettings] = React.useState({ closed: false, closed_message: "We'll be right back!" });
  const { connected, setConnected, makeSubscribeCallback } = useConnected();

  const fetchAll = React.useCallback(async () => {
    const { data, error } = await db.from('clients').select('*').order('seq', { ascending: true });
    if (error) {
      setConnected(false);
    } else if (data) {
      setClients(data);
      setConnected(true);
    }
    setLoading(false);
  }, [db, setConnected]);

  const fetchSettings = React.useCallback(async () => {
    const { data, error } = await db.from('settings').select('*').eq('id', 1).single();
    if (!error && data) setSettings(data);
  }, [db]);

  React.useEffect(() => {
    fetchAll();
    fetchSettings();

    const channel = db.channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, () => {
        fetchAll();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' },
        ({ new: r }) => setSettings(r)
      )
      .subscribe(makeSubscribeCallback(fetchAll));

    const presenceId = setInterval(() => {
      if (channel.status === 'closed' || channel.status === 'errored') {
        setConnected(false);
      }
    }, 2000);

    return () => {
      clearInterval(presenceId);
      db.removeChannel(channel);
    };
  }, [db, channelName, fetchAll, fetchSettings, makeSubscribeCallback, setConnected]);

  return { clients, setClients, loading, settings, setSettings, connected, setConnected, fetchAll };
}

// ============================================================
// Components
// ============================================================

function formatClientName(first, last) {
  const f = first?.trim() || null;
  const l = last?.trim() || null;

  const firstPart = f ?? html`<span className="name-blank">?</span>`;
  const lastPart = l ? (l[0].toUpperCase() + '.') : html`<span className="name-blank">?</span>`;

  return html`<${React.Fragment}>${firstPart} ${lastPart}<//>`;
}

function SharedLoginForm({ title, db, theme = 'light' }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return html`
    <div className=${`login-page ${theme === 'dark' ? 'dark-theme' : ''}`}>
      <div className="login-card">
        <h1>${title}</h1>
        <p className="login-sub">Sign in to manage the waiting room</p>

        ${error && html`<div className="login-error">${error}</div>`}

        <form onSubmit=${handleSubmit}>
          <div className="form-field">
            <label>Email</label>
            <input
              type="email"
              autoFocus
              autoComplete="email"
              value=${email}
              onChange=${e => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value=${password}
              onChange=${e => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="btn btn-primary login-btn" type="submit" disabled=${loading}>
            ${loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  `;
}

function AuthShell({ children, db, title, theme }) {
  const [session, setSession] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    db.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    const { data: { subscription } } = db.auth.onAuthStateChange((_, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, [db]);

  if (loading) return html`<div className="auth-loading">Loading…</div>`;
  if (!session) return html`<${SharedLoginForm} title=${title} db=${db} theme=${theme} />`;

  return html`${React.Children.map(children, child =>
    React.cloneElement(child, { userEmail: session.user.email, db })
  )}`;
}

// ============================================================
// Shared Views
// ============================================================

function WaitingRoomView({ userEmail, db }) {
  const { clients, setClients, loading, settings, setSettings, connected, setConnected } = useRealtimeClients(db, 'clients-rt');
  const [showAdd, setShowAdd] = React.useState(false);
  const [newClient, setNewClient] = React.useState(EMPTY_NEW);
  const [editRow, setEditRow] = React.useState(null);
  const [deleteRow, setDeleteRow] = React.useState(null);
  const [showClear, setShowClear] = React.useState(false);
  const [showClose, setShowClose] = React.useState(false);
  const [closeMsg, setCloseMsg] = React.useState('');
  const [draggingIdx, setDraggingIdx] = React.useState(null);
  const [dragOverIdx, setDragOverIdx] = React.useState(null);

  const rows = [...clients].sort((a, b) => a.seq - b.seq);

  const handleAdd = async () => {
    if (!newClient.name_first.trim() && !newClient.name_last.trim()) return;
    const prev = clients;
    const maxSeq = rows.length > 0 ? Math.max(...rows.map(c => c.seq)) : 0;
    
    const formattedFirst = formatNameInput(newClient.name_first);
    const formattedLast  = formatNameInput(newClient.name_last);

    const optimistic = { 
      ...newClient, 
      id: Date.now(),
      seq: maxSeq + 1,
      name_first: formattedFirst,
      name_last: formattedLast
    };
    
    setClients(p => [...p, optimistic]);
    setNewClient(EMPTY_NEW);
    setShowAdd(false);

    const { error } = await db.from('clients').insert({
      name_first: optimistic.name_first || null,
      name_last:  optimistic.name_last  || null,
      appt_time:  optimistic.appt_time  || null,
      status:     optimistic.status     || null,
    });
    
    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  const handleDelete = async () => {
    const prev = clients;
    const targetId = deleteRow.id;
    setClients(p => p.filter(c => c.id !== targetId));
    setDeleteRow(null);

    const { error } = await db.from('clients').delete().eq('id', targetId);
    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  const handleClearAll = async () => {
    const prev = clients;
    setClients([]);
    setShowClear(false);

    const { error } = await db.from('clients').delete().neq('id', 0);
    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  const handleCloseDisplay = async () => {
    const msg = closeMsg.trim() || "We'll be right back!";
    const prev = settings;
    setSettings(s => ({ ...s, closed: true, closed_message: msg }));
    setShowClose(false);

    const { error } = await db.from('settings').update({ closed: true, closed_message: msg }).eq('id', 1);
    if (error) {
      setConnected(false);
      setSettings(prev);
    }
  };

  const handleOpenDisplay = async () => {
    const prev = settings;
    setSettings(s => ({ ...s, closed: false }));
    
    const { error } = await db.from('settings').update({ closed: false }).eq('id', 1);
    if (error) {
      setConnected(false);
      setSettings(prev);
    }
  };

  const handleEditSave = async () => {
    const prev = clients;
    const formattedFirst = formatNameInput(editRow.name_first);
    const formattedLast  = formatNameInput(editRow.name_last);

    const updated = { 
      ...editRow,
      name_first: formattedFirst,
      name_last: formattedLast
    };

    setClients(p => p.map(c => c.id === updated.id ? updated : c));
    setEditRow(null);

    const { error } = await db.from('clients').update({
      name_first: updated.name_first || null,
      name_last:  updated.name_last  || null,
      appt_time:  updated.appt_time  || null,
    }).eq('id', updated.id);

    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  const handleStatus = async (id, status) => {
    const prev = clients;
    setClients(p => p.map(c => c.id === id ? { ...c, status: status || null } : c));
    const { error } = await db.from('clients').update({ status: status || null }).eq('id', id);
    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  const onDragStart = (e, idx) => {
    if (['BUTTON', 'SELECT', 'INPUT'].includes(e.target.tagName)) {
      e.preventDefault();
      return;
    }
    setDraggingIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  };

  const onDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };

  const onDrop = async (e, dropIdx) => {
    e.preventDefault();
    const fromIdx = draggingIdx;
    setDraggingIdx(null);
    setDragOverIdx(null);
    if (fromIdx === null || fromIdx === dropIdx) return;
    
    const prev = clients;
    const next = [...rows];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(dropIdx, 0, moved);
    const updated = next.map((c, i) => ({ ...c, seq: i + 1 }));
    
    setClients(updated);

    const { error } = await db.rpc('reorder_clients', { reorder_data: updated.map(c => ({ id: c.id, seq: c.seq })) });
    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  return html`
    <div>
      ${!connected && html`<div className="disconnect-overlay" />`}
      ${!connected && html`<div className="banner">⚠ Disconnected from database — changes are blocked until the connection is restored</div>`}

      <header className="header">
        <span className="header-title">CES Waiting Room</span>
        <div className="header-right">
          <span className="header-email">${userEmail}</span>
          ${settings.closed
            ? html`<button className="btn btn-ghost btn-sm" style=${{ color: '#69f0ae', borderColor: '#69f0ae' }} onClick=${handleOpenDisplay}>Open Display</button>`
            : html`<button className="btn btn-ghost btn-sm" onClick=${() => { setCloseMsg(settings.closed_message); setShowClose(true); }}>Close Display</button>`
          }
          <button className="btn btn-ghost btn-sm" onClick=${() => db.auth.signOut()}>Sign out</button>
        </div>
      </header>

      <div className="container">
        <div className="toolbar">
          <button className="btn btn-danger btn-sm" onClick=${() => setShowClear(true)} style=${{ marginRight: 'auto' }} disabled=${rows.length === 0}>Clear All</button>
          <button className="btn btn-primary" onClick=${() => setShowAdd(v => !v)}>${showAdd ? '✕ Cancel' : '+ Add Neighbor'}</button>
        </div>

        ${showAdd && html`
          <div className="card add-form animate-fade-in">
            <div className="form-row">
              <div className="form-field">
                <label>First Name</label>
                <input autoFocus placeholder="First name" value=${newClient.name_first} onChange=${e => setNewClient(p => ({ ...p, name_first: e.target.value }))} onKeyDown=${e => e.key === 'Enter' && handleAdd()} />
              </div>
              <div className="form-field">
                <label>Last Name</label>
                <input placeholder="Last name" value=${newClient.name_last} onChange=${e => setNewClient(p => ({ ...p, name_last: e.target.value }))} onKeyDown=${e => e.key === 'Enter' && handleAdd()} />
              </div>
              <div className="form-field">
                <label>Appt Time</label>
                <select value=${newClient.appt_time} onChange=${e => setNewClient(p => ({ ...p, appt_time: e.target.value }))}>
                  ${TIME_OPTIONS.map(t => html`<option key=${t}>${t}</option>`)}
                </select>
              </div>
              <div className="form-field">
                <label>Status</label>
                <select value=${newClient.status} onChange=${e => setNewClient(p => ({ ...p, status: e.target.value }))}>
                  ${STATUS_OPTIONS.map(s => html`<option key=${s}>${s}</option>`)}
                </select>
              </div>
              <button className="btn btn-primary" style=${{ alignSelf: 'flex-end' }} onClick=${handleAdd}>Add</button>
            </div>
          </div>
        `}

        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th style=${{ width: 44 }}></th>
                <th>First Name</th>
                <th>Last Name</th>
                <th>Appt Time</th>
                <th>Status</th>
                <th style=${{ width: 140 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${loading ? html`<tr><td colSpan=${6} className="empty-state">Loading neighbors…</td></tr>`
              : rows.length === 0 ? html`<tr><td colSpan=${6} className="empty-state">No neighbors in the waiting room</td></tr>` 
              : rows.map((c, idx) => html`
                <tr key=${c.id} draggable onDragStart=${e => onDragStart(e, idx)} onDragOver=${e => onDragOver(e, idx)} onDrop=${e => onDrop(e, idx)} onDragEnd=${() => { setDraggingIdx(null); setDragOverIdx(null); }}
                  className=${[draggingIdx === idx ? 'row-dragging' : '', dragOverIdx === idx ? 'row-drag-over' : ''].filter(Boolean).join(' ')}>
                  <td><span className="drag-handle" title="Drag to reorder">⠿</span></td>
                  <td>${c.name_first || html`<span className="muted">—</span>`}</td>
                  <td>${c.name_last  || html`<span className="muted">—</span>`}</td>
                  <td>${c.appt_time || html`<span className="muted">—</span>`}</td>
                  <td>
                    <select className=${`cell-select ${statusClass(c.status)}`} value=${c.status ?? ''} onChange=${e => handleStatus(c.id, e.target.value)}>
                      ${STATUS_OPTIONS.map(s => html`<option key=${s}>${s}</option>`)}
                    </select>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm btn-secondary" onClick=${() => setEditRow({ ...c })}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick=${() => setDeleteRow(c)}>Delete</button>
                    </div>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      </div>

      ${editRow && html`
        <div className="modal-overlay" onClick=${e => e.target === e.currentTarget && setEditRow(null)}>
          <div className="modal">
            <h2>Edit Neighbor</h2>
            <div className="form-field"><label>First Name</label><input autoFocus value=${editRow.name_first || ''} onChange=${e => setEditRow(p => ({ ...p, name_first: e.target.value }))} onKeyDown=${e => e.key === 'Enter' && handleEditSave()} /></div>
            <div className="form-field"><label>Last Name</label><input value=${editRow.name_last || ''} onChange=${e => setEditRow(p => ({ ...p, name_last: e.target.value }))} onKeyDown=${e => e.key === 'Enter' && handleEditSave()} /></div>
            <div className="form-field">
              <label>Appt Time</label>
              <select value=${editRow.appt_time || ''} onChange=${e => setEditRow(p => ({ ...p, appt_time: e.target.value }))}>
                ${TIME_OPTIONS.map(t => html`<option key=${t}>${t}</option>`)}
              </select>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick=${() => setEditRow(null)}>Cancel</button>
              <button className="btn btn-primary" onClick=${handleEditSave}>Save</button>
            </div>
          </div>
        </div>
      `}
      ${showClose && html`
        <div className="modal-overlay" onClick=${e => e.target === e.currentTarget && setShowClose(false)}>
          <div className="modal">
            <h2>Close Display</h2>
            <div className="form-field"><label>Message shown on display</label><input autoFocus value=${closeMsg} onChange=${e => setCloseMsg(e.target.value)} onKeyDown=${e => e.key === 'Enter' && handleCloseDisplay()} /></div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick=${() => setShowClose(false)}>Cancel</button>
              <button className="btn btn-danger" onClick=${handleCloseDisplay}>Close Display</button>
            </div>
          </div>
        </div>
      `}
      ${showClear && html`
        <div className="modal-overlay" onClick=${e => e.target === e.currentTarget && setShowClear(false)}>
          <div className="modal">
            <h2>Clear Waiting Room?</h2>
            <p className="modal-body">This will remove all ${rows.length} neighbor${rows.length !== 1 ? 's' : ''} from the waiting room.</p>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick=${() => setShowClear(false)}>Cancel</button>
              <button className="btn btn-danger" onClick=${handleClearAll}>Clear All</button>
            </div>
          </div>
        </div>
      `}
      ${deleteRow && html`
        <div className="modal-overlay" onClick=${e => e.target === e.currentTarget && setDeleteRow(null)}>
          <div className="modal">
            <h2>Remove Neighbor?</h2>
            <p className="modal-body">Remove <strong>${[deleteRow.name_first, deleteRow.name_last].filter(Boolean).join(' ') || 'this neighbor'}</strong>?</p>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick=${() => setDeleteRow(null)}>Cancel</button>
              <button className="btn btn-danger" onClick=${handleDelete}>Remove</button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

function TabletView({ userEmail, db }) {
  const { clients, setClients, connected, setConnected, loading } = useRealtimeClients(db, 'tablet-rt');
  const [loadingId, setLoadingId] = React.useState(null);

  const setStatus = async (id, status) => {
    const prev = clients;
    setClients(p => p.map(c => c.id === id ? { ...c, status } : c));
    
    setLoadingId(id);
    const { error } = await db.from('clients').update({ status }).eq('id', id);
    setLoadingId(null);

    if (error) {
      setConnected(false);
      setClients(prev);
    }
  };

  const checkedIn = clients.filter(c => c.status === 'Checked-in');
  const apptClients = checkedIn.filter(c => c.appt_time && c.appt_time !== 'Walk-in');
  const walkinClients = checkedIn.filter(c => c.appt_time === 'Walk-in');
  const shoppingClients = clients.filter(c => c.status === 'Shopping');

  return html`
    <${React.Fragment}>
      ${!connected && html`<div className="disconnect-overlay" />`}
      ${!connected && html`<div className="banner">⚠ Disconnected from database</div>`}
      <header className="header">
        <span className="header-title">CES Waiting Room</span>
        <div className="header-right">
          <span className="header-email">${userEmail}</span>
          <button className="btn btn-ghost" onClick=${() => db.auth.signOut()}>Sign out</button>
        </div>
      </header>

      <div className="columns">
        <div className="column">
          <div className="column-header">Appointments</div>
          <div className="name-list">
            ${loading ? html`<div className="empty-state dark-theme">Loading…</div>`
            : apptClients.length === 0 ? html`<div className="empty-state dark-theme">No appointments</div>` 
            : apptClients.map(c => html`
              <div className=${`client-card animate-fade-in ${loadingId === c.id ? 'loading-pulse' : ''}`} key=${c.id}>
                <span className="name-text">${formatClientName(c.name_first, c.name_last)}</span>
                <button className="shop-btn" onClick=${() => setStatus(c.id, 'Shopping')}>${loadingId === c.id ? '...' : 'Shopping'}</button>
              </div>
            `)}
          </div>
        </div>
        <div className="column">
          <div className="column-header">Walk-ins</div>
          <div className="name-list">
            ${loading ? html`<div className="empty-state dark-theme">Loading…</div>`
            : walkinClients.length === 0 ? html`<div className="empty-state dark-theme">No walk-ins</div>`
            : walkinClients.map(c => html`
              <div className=${`client-card animate-fade-in ${loadingId === c.id ? 'loading-pulse' : ''}`} key=${c.id}>
                <span className="name-text">${formatClientName(c.name_first, c.name_last)}</span>
                <button className="shop-btn" onClick=${() => setStatus(c.id, 'Shopping')}>${loadingId === c.id ? '...' : 'Shopping'}</button>
              </div>
            `)}
          </div>
        </div>
      </div>

      ${shoppingClients.length > 0 && html`
        <div className="tray">
          <div className="tray-header">Shopping</div>
          <div className="tray-list">
            ${shoppingClients.map(c => html`
              <div className=${`tray-item animate-fade-in ${loadingId === c.id ? 'loading-pulse' : ''}`} key=${c.id}>
                <span className="tray-name">${formatClientName(c.name_first, c.name_last)}</span>
                <button className="btn btn-secondary btn-sm" onClick=${() => setStatus(c.id, 'Checked-in')}>${loadingId === c.id ? '...' : '↩ Move back'}</button>
              </div>
            `)}
          </div>
        </div>
      `}
    <//>
  `;
}

function DisplayView({ db }) {
  const { clients, settings, connected, loading } = useRealtimeClients(db, 'display-rt');
  const [time, setTime] = React.useState(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  const [date, setDate] = React.useState(new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));

  React.useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      setTime(now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      setDate(now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = clients.filter(c => c.status === 'Checked-in');
  const apptClients = filtered.filter(c => c.appt_time && c.appt_time !== 'Walk-in');
  const walkinClients = filtered.filter(c => c.appt_time === 'Walk-in');

  return html`
    <${React.Fragment}>
      ${!connected && html`<div className="disconnect-overlay" />`}
      ${!connected && html`<div className="banner">⚠ Disconnected from database</div>`}
      <header className="header animate-fade-in">
        <span className="header-title">CES Waiting Room</span>
        <div className="header-right">
          <div className="header-datetime"><span className="header-date">${date}</span><div className="datetime-sep" /><span className="clock">${time}</span></div>
        </div>
      </header>
      ${settings.closed && html`<div className="closed-overlay"><div className="closed-message">${settings.closed_message || "We'll be right back!"}</div></div>`}
      <div className="columns">
        <div className="column">
          <div className="column-header">Appointments</div>
          <div className="name-list">
            ${loading ? html`<div className="empty-state dark-theme">Loading…</div>`
            : apptClients.length === 0 ? html`<div className="empty-state dark-theme">No appointments checked in</div>`
            : apptClients.map(c => html`<div className="name-row animate-fade-in" key=${c.id}><span className="name-text">${formatClientName(c.name_first, c.name_last)}</span></div>`)}
          </div>
        </div>
        <div className="column">
          <div className="column-header">Walk-ins</div>
          <div className="name-list">
            ${loading ? html`<div className="empty-state dark-theme">Loading…</div>`
            : walkinClients.length === 0 ? html`<div className="empty-state dark-theme">No walk-ins checked in</div>`
            : walkinClients.map(c => html`<div className="name-row animate-fade-in" key=${c.id}><span className="name-text">${formatClientName(c.name_first, c.name_last)}</span></div>`)}
          </div>
        </div>
      </div>
    <//>
  `;
}
