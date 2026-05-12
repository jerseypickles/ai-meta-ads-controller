import { useState, useEffect, useRef } from 'react';
import api from '../../api';

const HERMES_COLOR = '#f59e0b'; // amber — local/warm vibe
const OFFER_COLORS = {
  free_pickle: '#22c55e',
  big_dill_chamoy: '#ef4444',
  mystery_pickle: '#a855f7'
};

function OfferBadge({ type }) {
  const color = OFFER_COLORS[type] || '#94a3b8';
  const label = {
    free_pickle: 'Free Pickle',
    big_dill_chamoy: 'Big Dill Chamoy',
    mystery_pickle: 'Mystery Pickle'
  }[type] || type;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      background: `${color}22`,
      color,
      fontSize: '0.7rem',
      fontWeight: 600,
      letterSpacing: 0.3
    }}>{label}</span>
  );
}

function StatusBadge({ status }) {
  const colors = {
    pending: '#fbbf24',
    approved: '#34d399',
    rejected: '#f87171',
    live: '#60a5fa',
    paused: '#94a3b8',
    completed: '#a78bfa',
    expired: '#64748b'
  };
  const color = colors[status] || '#94a3b8';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      background: `${color}22`,
      color,
      fontSize: '0.7rem',
      fontWeight: 600,
      textTransform: 'uppercase'
    }}>{status}</span>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: Photo Bank
// ═══════════════════════════════════════════════════════════════════════

function PhotoBankTab() {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const [uploadForm, setUploadForm] = useState({
    tags: '',
    offer_types: 'any',
    mood: '',
    notes: ''
  });

  async function fetchPhotos() {
    setLoading(true);
    try {
      const { data } = await api.get('/api/hermes/photos');
      setPhotos(data.photos || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchPhotos(); }, []);

  async function handleUpload(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return alert('Selecciona una foto primero');

    setUploading(true);
    try {
      const form = new FormData();
      form.append('photo', file);
      Object.entries(uploadForm).forEach(([k, v]) => form.append(k, v));
      await api.post('/api/hermes/photos/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      fileRef.current.value = '';
      setUploadForm({ tags: '', offer_types: 'any', mood: '', notes: '' });
      await fetchPhotos();
    } catch (err) {
      alert(`Upload failed: ${err.response?.data?.error || err.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function toggleActive(photo) {
    await api.patch(`/api/hermes/photos/${photo._id}`, { active: !photo.active });
    fetchPhotos();
  }

  async function archivePhoto(photo) {
    if (!confirm(`Archive "${photo.filename}"?`)) return;
    await api.delete(`/api/hermes/photos/${photo._id}`);
    fetchPhotos();
  }

  return (
    <div>
      {/* Upload form */}
      <form onSubmit={handleUpload} style={{
        background: 'rgba(245, 158, 11, 0.08)',
        border: `1px solid ${HERMES_COLOR}44`,
        borderRadius: 8,
        padding: 16,
        marginBottom: 24
      }}>
        <h3 style={{ margin: '0 0 12px 0', color: HERMES_COLOR }}>📸 Subir foto al banco</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            required
            style={{ gridColumn: '1 / 3' }}
          />
          <input
            type="text"
            placeholder="Tags (CSV): hero, with-hand"
            value={uploadForm.tags}
            onChange={e => setUploadForm({ ...uploadForm, tags: e.target.value })}
          />
          <select
            value={uploadForm.offer_types}
            onChange={e => setUploadForm({ ...uploadForm, offer_types: e.target.value })}
          >
            <option value="any">Any offer</option>
            <option value="free_pickle">Free Pickle only</option>
            <option value="big_dill_chamoy">Big Dill Chamoy only</option>
            <option value="mystery_pickle">Mystery Pickle only</option>
            <option value="free_pickle,big_dill_chamoy">Free Pickle + Big Dill</option>
            <option value="free_pickle,mystery_pickle">Free Pickle + Mystery</option>
          </select>
          <select
            value={uploadForm.mood}
            onChange={e => setUploadForm({ ...uploadForm, mood: e.target.value })}
          >
            <option value="">— Mood (optional) —</option>
            <option value="playful">Playful</option>
            <option value="gourmet">Gourmet</option>
            <option value="casual">Casual</option>
            <option value="bold">Bold</option>
            <option value="cozy">Cozy</option>
          </select>
          <input
            type="text"
            placeholder="Notes (optional)"
            value={uploadForm.notes}
            onChange={e => setUploadForm({ ...uploadForm, notes: e.target.value })}
          />
        </div>
        <button
          type="submit"
          disabled={uploading}
          style={{
            background: HERMES_COLOR,
            color: '#0a0a0a',
            border: 'none',
            padding: '8px 16px',
            borderRadius: 6,
            fontWeight: 700,
            cursor: uploading ? 'wait' : 'pointer'
          }}
        >
          {uploading ? 'Subiendo...' : 'Subir foto'}
        </button>
      </form>

      {/* Grid de fotos */}
      {loading ? (
        <p>Cargando...</p>
      ) : photos.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>Banco vacío. Sube fotos profesionales del producto (estilo Big Dill Chamoy).</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
          {photos.map(p => (
            <div key={p._id} style={{
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${p.active ? 'rgba(245,158,11,0.3)' : 'rgba(100,116,139,0.3)'}`,
              borderRadius: 8,
              overflow: 'hidden',
              opacity: p.active ? 1 : 0.5
            }}>
              <img
                src={`${api.defaults.baseURL}/api/hermes/photos/${p._id}/image?token=${localStorage.getItem('auth_token') || ''}`}
                alt={p.filename}
                style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block' }}
              />
              <div style={{ padding: 10, fontSize: '0.78rem' }}>
                <div style={{ fontWeight: 600, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.filename}</div>
                <div style={{ color: '#94a3b8', marginBottom: 6 }}>
                  {p.width}×{p.height} · usado {p.usage_count}x
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                  {(p.offer_types || []).map(t => <OfferBadge key={t} type={t} />)}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => toggleActive(p)}
                    style={{
                      flex: 1, padding: '4px 8px', fontSize: '0.7rem',
                      background: p.active ? '#94a3b822' : '#22c55e22',
                      color: p.active ? '#94a3b8' : '#22c55e',
                      border: 'none', borderRadius: 4, cursor: 'pointer'
                    }}
                  >
                    {p.active ? 'Desactivar' : 'Activar'}
                  </button>
                  <button
                    onClick={() => archivePhoto(p)}
                    style={{
                      padding: '4px 8px', fontSize: '0.7rem',
                      background: '#ef444422', color: '#ef4444',
                      border: 'none', borderRadius: 4, cursor: 'pointer'
                    }}
                  >
                    🗑
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: Proposals approval queue
// ═══════════════════════════════════════════════════════════════════════

function ProposalsTab() {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [triggering, setTriggering] = useState(false);

  async function fetchProposals() {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/hermes/proposals?status=${filter}`);
      setProposals(data.proposals || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchProposals(); }, [filter]);

  async function approve(p) {
    await api.post(`/api/hermes/proposals/${p._id}/approve`);
    fetchProposals();
  }

  async function reject(p) {
    const reason = prompt('Razón de rechazo (opcional):') || '';
    await api.post(`/api/hermes/proposals/${p._id}/reject`, { reason });
    fetchProposals();
  }

  async function triggerCycle() {
    setTriggering(true);
    try {
      // Timeout 3 min — gpt-image-2 high quality puede tardar 60-90s,
      // sumado al brief de Claude (~10s) total puede llegar a ~100s
      const { data } = await api.post('/api/hermes/trigger-cycle', null, { timeout: 180000 });
      if (data.skipped) alert(`Skipped: ${data.reason}`);
      else if (data.generated) alert(`Proposal generado: ${data.offer_type}`);
      await fetchProposals();
    } catch (err) {
      // Si fue timeout del axios cliente, el backend probablemente sigue
      // generando. Refrescamos la lista igual para mostrar cuando aparezca.
      const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message);
      if (isTimeout) {
        alert('Generación en progreso (>3min). Refrescá en 1-2 minutos para ver el proposal.');
        await fetchProposals();
      } else {
        alert(`Error: ${err.response?.data?.error || err.message}`);
      }
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {['pending', 'approved', 'rejected', 'live', 'all'].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              style={{
                padding: '6px 12px', fontSize: '0.78rem',
                background: filter === s ? `${HERMES_COLOR}33` : 'transparent',
                color: filter === s ? HERMES_COLOR : '#94a3b8',
                border: `1px solid ${filter === s ? HERMES_COLOR : '#334155'}`,
                borderRadius: 6, cursor: 'pointer', textTransform: 'capitalize'
              }}
            >{s}</button>
          ))}
        </div>
        <button
          onClick={triggerCycle}
          disabled={triggering}
          style={{
            background: HERMES_COLOR, color: '#0a0a0a',
            border: 'none', padding: '6px 14px', borderRadius: 6,
            fontWeight: 700, cursor: triggering ? 'wait' : 'pointer', fontSize: '0.8rem'
          }}
        >
          {triggering ? 'Generando...' : '⚡ Generar ahora'}
        </button>
      </div>

      {loading ? (
        <p>Cargando...</p>
      ) : proposals.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>Sin proposals en este estado.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
          {proposals.map(p => (
            <div key={p._id} style={{
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${HERMES_COLOR}33`,
              borderRadius: 8,
              overflow: 'hidden'
            }}>
              <img
                src={`${api.defaults.baseURL}/api/hermes/proposals/${p._id}/image?token=${localStorage.getItem('auth_token') || ''}`}
                alt="composed ad"
                style={{ width: '100%', display: 'block', background: '#000' }}
              />
              <div style={{ padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                  <OfferBadge type={p.offer_type} />
                  <StatusBadge status={p.status} />
                </div>
                <div style={{ fontWeight: 700, fontSize: '0.92rem', marginBottom: 4 }}>{p.headline}</div>
                <div style={{ fontSize: '0.78rem', color: '#cbd5e1', marginBottom: 10, lineHeight: 1.4 }}>
                  {p.primary_text}
                </div>
                <div style={{ fontSize: '0.7rem', color: '#64748b', marginBottom: 10 }}>
                  CTA: {p.cta_button} · {new Date(p.generated_at).toLocaleString()}
                </div>
                {p.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => approve(p)}
                      style={{
                        flex: 1, padding: '8px', background: '#22c55e',
                        color: '#000', border: 'none', borderRadius: 6,
                        fontWeight: 700, cursor: 'pointer', fontSize: '0.78rem'
                      }}
                    >✓ Aprobar</button>
                    <button
                      onClick={() => reject(p)}
                      style={{
                        flex: 1, padding: '8px', background: '#ef4444',
                        color: '#fff', border: 'none', borderRadius: 6,
                        fontWeight: 700, cursor: 'pointer', fontSize: '0.78rem'
                      }}
                    >✗ Rechazar</button>
                  </div>
                )}
                {p.rejection_reason && (
                  <div style={{ fontSize: '0.72rem', color: '#f87171', marginTop: 8 }}>
                    Razón: {p.rejection_reason}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB: Store Visits logger + stats
// ═══════════════════════════════════════════════════════════════════════

function VisitsTab() {
  const [visits, setVisits] = useState([]);
  const [stats, setStats] = useState(null);
  const [form, setForm] = useState({
    source_offer: 'free_pickle',
    source_platform: 'facebook',
    converted_to_purchase: false,
    purchase_amount: 0,
    customer_zip: '',
    is_first_visit: null,
    visitor_party_size: 1,
    notes: ''
  });

  async function fetchAll() {
    const [v, s] = await Promise.all([
      api.get('/api/hermes/visits?days=30'),
      api.get('/api/hermes/stats?days=30')
    ]);
    setVisits(v.data.visits || []);
    setStats(s.data);
  }

  useEffect(() => { fetchAll(); }, []);

  async function logVisit(e) {
    e.preventDefault();
    try {
      await api.post('/api/hermes/visits', form);
      setForm({
        source_offer: 'free_pickle',
        source_platform: 'facebook',
        converted_to_purchase: false,
        purchase_amount: 0,
        customer_zip: '',
        is_first_visit: null,
        visitor_party_size: 1,
        notes: ''
      });
      fetchAll();
    } catch (err) {
      alert(`Error: ${err.response?.data?.error || err.message}`);
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      {/* Form */}
      <form onSubmit={logVisit} style={{
        background: 'rgba(245, 158, 11, 0.08)',
        border: `1px solid ${HERMES_COLOR}44`,
        borderRadius: 8,
        padding: 16
      }}>
        <h3 style={{ margin: '0 0 12px 0', color: HERMES_COLOR }}>🚪 Loggear visita</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          <label>
            <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: 3 }}>¿Qué oferta mencionó?</div>
            <select value={form.source_offer} onChange={e => setForm({ ...form, source_offer: e.target.value })}>
              <option value="free_pickle">Free Pickle</option>
              <option value="big_dill_chamoy">Big Dill Chamoy</option>
              <option value="mystery_pickle">Mystery Pickle</option>
              <option value="other">Otra</option>
              <option value="unknown">No supo decir</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: 3 }}>Plataforma</div>
            <select value={form.source_platform} onChange={e => setForm({ ...form, source_platform: e.target.value })}>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
              <option value="unknown">No supo</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={form.converted_to_purchase}
              onChange={e => setForm({ ...form, converted_to_purchase: e.target.checked })}
            />
            <span style={{ fontSize: '0.85rem' }}>¿Compró algo?</span>
          </label>
          {form.converted_to_purchase && (
            <input
              type="number"
              step="0.01"
              placeholder="Monto compra $"
              value={form.purchase_amount}
              onChange={e => setForm({ ...form, purchase_amount: parseFloat(e.target.value) || 0 })}
            />
          )}
          <input
            type="text"
            placeholder="Zip code del cliente (opcional)"
            value={form.customer_zip}
            onChange={e => setForm({ ...form, customer_zip: e.target.value })}
          />
          <textarea
            placeholder="Notas (opcional)"
            value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
            rows="2"
          />
          <button
            type="submit"
            style={{
              background: HERMES_COLOR, color: '#0a0a0a',
              border: 'none', padding: '10px', borderRadius: 6,
              fontWeight: 700, cursor: 'pointer'
            }}
          >Registrar visita</button>
        </div>
      </form>

      {/* Stats */}
      <div>
        <h3 style={{ margin: '0 0 12px 0', color: HERMES_COLOR }}>📊 Últimos 30 días</h3>
        {stats?.visits?.by_offer?.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {stats.visits.by_offer.map(s => (
              <div key={s._id} style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid #334155',
                borderRadius: 6,
                padding: 12,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <OfferBadge type={s._id} />
                <div style={{ fontSize: '0.85rem', textAlign: 'right' }}>
                  <div><strong>{s.count}</strong> visitas</div>
                  <div style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                    {s.converted} comp · ${Math.round(s.revenue)} rev
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: '#94a3b8' }}>Aún sin visitas registradas.</p>
        )}

        <h4 style={{ margin: '20px 0 8px 0', color: '#cbd5e1', fontSize: '0.85rem' }}>Últimas 10 visitas</h4>
        <div style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
          {visits.slice(0, 10).map(v => (
            <div key={v._id} style={{
              padding: 8,
              background: 'rgba(255,255,255,0.02)',
              borderLeft: `3px solid ${OFFER_COLORS[v.source_offer] || '#94a3b8'}`,
              fontSize: '0.75rem',
              display: 'flex',
              justifyContent: 'space-between'
            }}>
              <span>{v.source_offer} {v.converted_to_purchase ? `· $${v.purchase_amount}` : ''}</span>
              <span style={{ color: '#94a3b8' }}>{new Date(v.visited_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN: HermesPanel
// ═══════════════════════════════════════════════════════════════════════

export default function HermesPanel() {
  const [tab, setTab] = useState('proposals');
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.get('/api/hermes/stats').then(r => setStats(r.data)).catch(() => {});
  }, []);

  return (
    <div style={{ padding: 24, color: '#e2e8f0', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, color: HERMES_COLOR, fontSize: '1.4rem' }}>
            🏪 Hermes — NJ Store Foot Traffic
          </h2>
          <p style={{ margin: '4px 0 0 0', color: '#94a3b8', fontSize: '0.85rem' }}>
            9 Romanelli Ave · South Hackensack, NJ 07606
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: '0.78rem' }}>
          <div style={{
            padding: '6px 12px',
            borderRadius: 6,
            background: stats?.config?.enabled ? '#22c55e22' : '#64748b22',
            color: stats?.config?.enabled ? '#22c55e' : '#94a3b8'
          }}>
            {stats?.config?.enabled ? '● Enabled' : '○ Disabled'}
          </div>
          <div style={{
            padding: '6px 12px',
            borderRadius: 6,
            background: '#334155',
            color: '#cbd5e1'
          }}>
            Mode: {stats?.config?.mode || '—'}
          </div>
        </div>
      </div>

      {/* Stats strip */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Ofertas activas" value="3" subtitle="free · bigdill · mystery" />
          <StatCard label="Pending approval" value={stats.proposals?.pending} highlight={stats.proposals?.pending > 0} />
          <StatCard label="Ads live" value={stats.proposals?.live} />
          <StatCard
            label="Visitas (30d)"
            value={(stats.visits?.by_offer || []).reduce((s, o) => s + o.count, 0)}
          />
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #334155' }}>
        {[
          { id: 'proposals', label: '📋 Proposals' },
          { id: 'visits', label: '🚪 Store Visits' }
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t.id ? `2px solid ${HERMES_COLOR}` : '2px solid transparent',
              color: tab === t.id ? HERMES_COLOR : '#94a3b8',
              cursor: 'pointer',
              fontWeight: tab === t.id ? 700 : 400,
              fontSize: '0.9rem'
            }}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'proposals' && <ProposalsTab />}
      {tab === 'visits' && <VisitsTab />}
    </div>
  );
}

function StatCard({ label, value, subtitle, highlight }) {
  return (
    <div style={{
      background: highlight ? 'rgba(245, 158, 11, 0.15)' : 'rgba(255,255,255,0.03)',
      border: `1px solid ${highlight ? HERMES_COLOR : '#334155'}`,
      borderRadius: 8,
      padding: 14
    }}>
      <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color: highlight ? HERMES_COLOR : '#e2e8f0' }}>
        {value ?? '—'}
      </div>
      {subtitle && <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}
