import React, { useCallback, useEffect, useState } from 'react';
import {
  Image,
  Loader,
  Upload,
  XCircle,
  CheckCircle,
  Sparkles,
  Zap,
  Palette,
  Tag,
  Search,
  Filter,
  Eye,
  Trash2,
  ExternalLink,
  X,
  ChevronDown,
  ChevronRight,
  Edit3,
  Package,
  Layers,
  Brain
} from 'lucide-react';
import {
  getCreativeAssets,
  uploadCreativeAsset,
  updateCreativeAsset,
  archiveCreativeAsset,
  uploadCreativeToMeta,
  detectProductForAsset,
  bulkDetectProducts,
  getCreativePreviewUrl,
  generateCreativePrompt,
  generateCreativeImages,
  judgeGeneratedImages,
  getGeneratedPreviewUrl,
  acceptGeneratedCreative,
  syncCreativeMetrics
} from '../api';

// =============================================
// CONSTANTS
// =============================================

const STYLES = [
  { value: 'organic', label: 'Organic', color: '#ef4444', desc: 'Casual, autentico, iPhone', icon: '📱' },
  { value: 'polished', label: 'Polished', color: '#3b82f6', desc: 'Premium, editorial', icon: '✨' },
  { value: 'ugc', label: 'UGC', color: '#10b981', desc: 'User generated content', icon: '🤳' },
  { value: 'meme', label: 'Meme', color: '#f59e0b', desc: 'Humor viral', icon: '😂' },
  { value: 'other', label: 'Otro', color: '#6b7280', desc: 'Sin clasificar', icon: '📁' }
];

const STYLE_COLORS = { organic: '#ef4444', 'ugly-ad': '#ef4444', polished: '#3b82f6', ugc: '#10b981', meme: '#f59e0b', other: '#6b7280' };

const TAGS_PRESETS = ['producto', 'lifestyle', 'promo', 'seasonal', 'best-seller', 'nuevo', 'hero', 'variante'];

// =============================================
// MAIN COMPONENT
// =============================================

const CreativeBank = () => {
  // Data state
  const [loading, setLoading] = useState(true);
  const [creatives, setCreatives] = useState([]);

  // Filter state
  const [filter, setFilter] = useState({ purpose: '', style: '', search: '', usage: '', product_line: '' });
  // View mode: 'grid' (flat) or 'byProduct' (organized by product_line/flavor)
  const [viewMode, setViewMode] = useState('byProduct');
  // Active product line tab and flavor tab
  const [activeProductLine, setActiveProductLine] = useState(null);
  const [activeFlavor, setActiveFlavor] = useState(null);
  // Bulk detect state
  const [bulkDetecting, setBulkDetecting] = useState(false);
  // Sync metrics state
  const [syncingMetrics, setSyncingMetrics] = useState(false);

  // Upload state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadPreview, setUploadPreview] = useState(null);
  const [uploadMeta, setUploadMeta] = useState({ purpose: 'ad-ready', style: 'other', tags: [], headline: '', notes: '', link_url: '' });
  const [uploading, setUploading] = useState(false);

  // Detail modal
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [editingAsset, setEditingAsset] = useState(null);
  const [savingAsset, setSavingAsset] = useState(false);
  const [detectingProduct, setDetectingProduct] = useState(false);

  // Preview lightbox
  const [previewImage, setPreviewImage] = useState(null);

  // AI Generation state
  const [showGenModal, setShowGenModal] = useState(false);
  const [genStep, setGenStep] = useState('product');
  const [genConfig, setGenConfig] = useState({ style: 'organic', format: 'feed', instruction: '', productId: null, referenceIds: [] });
  const [genPromptResult, setGenPromptResult] = useState(null);
  const [genImageResults, setGenImageResults] = useState(null);
  const [genLoading, setGenLoading] = useState(false);
  const [genAccepting, setGenAccepting] = useState(new Set());
  const [genAccepted, setGenAccepted] = useState(new Set());
  const [genJudgeResult, setGenJudgeResult] = useState(null);
  const [genJudging, setGenJudging] = useState(false);

  // =============================================
  // DATA LOADING
  // =============================================

  const fetchData = useCallback(async () => {
    try {
      const data = await getCreativeAssets('active');
      setCreatives(data?.assets || []);
    } catch (error) {
      console.error('Error cargando creativos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // =============================================
  // DERIVED DATA
  // =============================================

  const products = creatives.filter(a => a.purpose === 'reference');
  const adReady = creatives.filter(a => a.purpose !== 'reference');
  const aiGenerated = creatives.filter(a => a.generated_by && a.generated_by !== 'manual');

  const usedInAdsets = creatives.filter(a => (a.used_in_adsets?.length || 0) > 0 || (a.adset_usage?.length || 0) > 0);
  const unusedCreatives = creatives.filter(a => a.purpose === 'ad-ready' && (a.times_used || 0) === 0);

  // Extract unique product lines for filter
  const productLines = [...new Set(creatives.map(a => a.product_line).filter(Boolean))].sort();

  const filteredCreatives = creatives.filter(a => {
    if (filter.purpose && a.purpose !== filter.purpose) return false;
    if (filter.style && (a.style || 'other') !== filter.style) return false;
    if (filter.usage === 'used' && (a.times_used || 0) === 0) return false;
    if (filter.usage === 'unused' && (a.times_used || 0) > 0) return false;
    if (filter.product_line && (a.product_line || '') !== filter.product_line) return false;
    if (filter.search) {
      const q = filter.search.toLowerCase();
      const searchable = `${a.headline || ''} ${a.original_name || ''} ${a.product_name || ''} ${a.product_line || ''} ${a.flavor || ''} ${(a.tags || []).join(' ')} ${a.notes || ''}`.toLowerCase();
      if (!searchable.includes(q)) return false;
    }
    return true;
  });

  // Group by product_line > flavor for byProduct view
  const groupedByProduct = (() => {
    const groups = {};
    for (const a of filteredCreatives) {
      const line = a.product_line || 'Sin Clasificar';
      const flav = a.flavor || 'General';
      if (!groups[line]) groups[line] = {};
      if (!groups[line][flav]) groups[line][flav] = { reference: [], adReady: [] };
      if (a.purpose === 'reference') {
        groups[line][flav].reference.push(a);
      } else {
        groups[line][flav].adReady.push(a);
      }
    }
    return groups;
  })();

  // Auto-select first product line and flavor when data loads
  const sortedProductLines = Object.keys(groupedByProduct).sort((a, b) => a === 'Sin Clasificar' ? 1 : b === 'Sin Clasificar' ? -1 : a.localeCompare(b));
  const effectiveProductLine = activeProductLine && groupedByProduct[activeProductLine] ? activeProductLine : sortedProductLines[0] || null;
  const currentFlavors = effectiveProductLine ? groupedByProduct[effectiveProductLine] : {};
  const sortedFlavors = Object.keys(currentFlavors).sort((a, b) => a === 'General' ? 1 : b === 'General' ? -1 : a.localeCompare(b));
  const effectiveFlavor = activeFlavor && currentFlavors[activeFlavor] ? activeFlavor : sortedFlavors[0] || null;
  const currentFlavorAssets = effectiveFlavor ? currentFlavors[effectiveFlavor] : { reference: [], adReady: [] };

  // =============================================
  // UPLOAD HANDLERS
  // =============================================

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    setUploadMeta({ purpose: 'ad-ready', style: 'other', ad_format: 'feed', tags: [], headline: file.name.replace(/\.[^.]+$/, ''), notes: '', link_url: '', product_name: '', product_line: '', flavor: '' });
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => setUploadPreview(ev.target.result);
      reader.readAsDataURL(file);
    } else {
      setUploadPreview(null);
    }
    setShowUploadModal(true);
    e.target.value = '';
  };

  const handleConfirmUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('headline', uploadMeta.headline || uploadFile.name.replace(/\.[^.]+$/, ''));
      formData.append('purpose', uploadMeta.purpose);
      formData.append('style', uploadMeta.style);
      formData.append('tags', JSON.stringify(uploadMeta.tags));
      formData.append('notes', uploadMeta.notes || '');
      formData.append('link_url', uploadMeta.link_url || '');
      formData.append('product_name', uploadMeta.product_name || '');
      formData.append('product_line', uploadMeta.product_line || '');
      formData.append('flavor', uploadMeta.flavor || '');
      formData.append('ad_format', uploadMeta.ad_format || 'feed');
      formData.append('cta', 'SHOP_NOW');
      await uploadCreativeAsset(formData);
      await fetchData();
      setShowUploadModal(false);
      setUploadFile(null);
      setUploadPreview(null);
    } catch (error) {
      alert(`Error subiendo: ${error.response?.data?.error || error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const toggleUploadTag = (tag) => {
    setUploadMeta(prev => ({
      ...prev,
      tags: prev.tags.includes(tag) ? prev.tags.filter(t => t !== tag) : [...prev.tags, tag]
    }));
  };

  // =============================================
  // ASSET ACTIONS
  // =============================================

  const handleDeleteCreative = async (id) => {
    if (!window.confirm('Eliminar este creative permanentemente?')) return;
    try {
      await archiveCreativeAsset(id);
      setSelectedAsset(null);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleUploadToMeta = async (id) => {
    try {
      await uploadCreativeToMeta(id);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleDetectProduct = async () => {
    if (!selectedAsset) return;
    setDetectingProduct(true);
    try {
      const result = await detectProductForAsset(selectedAsset._id);
      if (result.success && result.product_name) {
        setEditingAsset(prev => ({
          ...prev,
          product_name: result.product_name,
          product_line: result.product_line || prev.product_line || '',
          flavor: result.flavor || prev.flavor || ''
        }));
      } else {
        alert('No se pudo detectar el producto automaticamente');
      }
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setDetectingProduct(false);
    }
  };

  const handleBulkDetect = async () => {
    const unclassified = creatives.filter(a => a.media_type === 'image' && (!a.product_line || !a.flavor));
    if (unclassified.length === 0) {
      alert('Todos los assets ya tienen linea y sabor');
      return;
    }
    if (!window.confirm(`Detectar producto, linea y sabor en ${unclassified.length} assets con IA?\nEsto puede tardar ~${Math.ceil(unclassified.length * 3 / 60)} minutos.`)) return;
    setBulkDetecting(true);
    try {
      const result = await bulkDetectProducts();
      alert(`Completado: ${result.updated}/${result.total} actualizados${result.errors > 0 ? `, ${result.errors} errores` : ''}`);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setBulkDetecting(false);
    }
  };

  const handleSyncMetrics = async () => {
    setSyncingMetrics(true);
    try {
      const result = await syncCreativeMetrics();
      await fetchData();
      const parts = [];
      if (result.discovered > 0) parts.push(`${result.discovered} links descubiertos`);
      if (result.synced > 0) parts.push(`${result.synced} creativos actualizados`);
      if (parts.length === 0) parts.push('No se encontraron ads vinculados a creativos');
      alert(`Sync completado: ${parts.join(', ')}`);
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setSyncingMetrics(false);
    }
  };

  const handleSaveAsset = async () => {
    if (!editingAsset) return;
    setSavingAsset(true);
    try {
      await updateCreativeAsset(editingAsset._id, {
        headline: editingAsset.headline,
        link_url: editingAsset.link_url || '',
        product_name: editingAsset.product_name || '',
        product_line: editingAsset.product_line || '',
        flavor: editingAsset.flavor || '',
        notes: editingAsset.notes,
        purpose: editingAsset.purpose,
        style: editingAsset.style,
        ad_format: editingAsset.ad_format || '',
        tags: editingAsset.tags
      });
      setSelectedAsset(null);
      setEditingAsset(null);
      await fetchData();
    } catch (error) {
      alert(`Error guardando: ${error.response?.data?.error || error.message}`);
    } finally {
      setSavingAsset(false);
    }
  };

  // =============================================
  // AI GENERATION HANDLERS
  // =============================================

  const handleOpenGenModal = () => {
    setShowGenModal(true);
    setGenStep('product');
    setGenConfig({ style: 'organic', format: 'feed', instruction: '', productId: null, referenceIds: [] });
    setGenPromptResult(null);
    setGenImageResults(null);
    setGenAccepting(new Set());
    setGenAccepted(new Set());
    setGenJudgeResult(null);
    setGenJudging(false);
  };

  const handleCloseGenModal = () => {
    setShowGenModal(false);
    setGenStep('product');
    setGenLoading(false);
  };

  const handleSelectProduct = (id) => {
    setGenConfig(prev => ({ ...prev, productId: id }));
    setGenStep('references');
  };

  const toggleReference = (id) => {
    setGenConfig(prev => ({
      ...prev,
      referenceIds: prev.referenceIds.includes(id)
        ? prev.referenceIds.filter(r => r !== id)
        : [...prev.referenceIds, id]
    }));
  };

  const handleGeneratePrompt = async () => {
    setGenLoading(true);
    try {
      const result = await generateCreativePrompt({
        style: genConfig.style,
        format: genConfig.format,
        userInstruction: genConfig.instruction,
        productId: genConfig.productId,
        referenceIds: genConfig.referenceIds
      });
      setGenPromptResult(result);
      setGenStep('prompt');
    } catch (error) {
      alert(`Error generando prompt: ${error.response?.data?.error || error.message}`);
    } finally {
      setGenLoading(false);
    }
  };

  const handleGenerateImages = async () => {
    setGenLoading(true);
    setGenStep('generating');
    setGenJudgeResult(null);
    setGenJudging(false);
    try {
      const result = await generateCreativeImages({
        prompts: genPromptResult.prompts,
        format: genConfig.format,
        productId: genConfig.productId
      });
      setGenImageResults(result);
      setGenStep('preview');

      // Auto-trigger judge in background
      const validImages = (result.images || []).filter(img => img.filename && !img.error);
      if (validImages.length > 0) {
        setGenJudging(true);
        try {
          const judgeResult = await judgeGeneratedImages({
            images: result.images,
            style: genConfig.style,
            format: genConfig.format
          });
          setGenJudgeResult(judgeResult);
        } catch (judgeErr) {
          console.error('Error en jurado IA:', judgeErr);
        } finally {
          setGenJudging(false);
        }
      }
    } catch (error) {
      alert(`Error generando imagenes: ${error.response?.data?.error || error.message}`);
      setGenStep('prompt');
    } finally {
      setGenLoading(false);
    }
  };

  const handleAcceptGenerated = async (img) => {
    if (!img?.filename) return;
    if (genAccepted.has(img.filename)) return;
    setGenAccepting(prev => new Set([...prev, img.filename]));
    try {
      await acceptGeneratedCreative({
        filename: img.filename,
        prompt: img.prompt,
        style: genConfig.style,
        format: genConfig.format,
        ad_format: img.ad_format || genConfig.format,
        headline: genPromptResult?.suggested_headline || '',
        productId: genConfig.productId,
        suggested_headline: genPromptResult?.suggested_headline || '',
        suggested_body: genPromptResult?.suggested_body || '',
        scene_label: img.scene_label || ''
      });
      setGenAccepted(prev => new Set([...prev, img.filename]));
      await fetchData();
    } catch (error) {
      alert(`Error aceptando: ${error.response?.data?.error || error.message}`);
    } finally {
      setGenAccepting(prev => {
        const next = new Set(prev);
        next.delete(img.filename);
        return next;
      });
    }
  };

  // =============================================
  // RENDER
  // =============================================

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size={24} className="spin" color="#c084fc" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1400px' }}>
      {/* ========= HEADER ========= */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: '800', color: '#f3f4f6', margin: 0, letterSpacing: '-0.02em' }}>
              Banco Creativo
            </h1>
            <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>
              {creatives.length} assets | {products.length} productos base | {adReady.length} ad-ready | {aiGenerated.length} generados IA | {usedInAdsets.length} en ad sets | {unusedCreatives.length} sin usar
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {/* Bulk classify button — show when there are unclassified assets */}
            {/* Sync metrics button — always visible, discovers ad-creative links + syncs performance */}
              <button onClick={handleSyncMetrics} disabled={syncingMetrics} style={{
                padding: '9px 16px', borderRadius: '10px', border: 'none', cursor: syncingMetrics ? 'wait' : 'pointer',
                fontSize: '13px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '7px',
                backgroundColor: '#1e3a5f', color: '#93c5fd', opacity: syncingMetrics ? 0.7 : 1
              }}>
              <Zap size={15} />
                {syncingMetrics ? 'Sincronizando...' : 'Sync Métricas'}
              </button>
            {creatives.filter(a => a.media_type === 'image' && (!a.product_line || !a.flavor)).length > 0 && (
              <button onClick={handleBulkDetect} disabled={bulkDetecting} style={{
                padding: '9px 16px', borderRadius: '10px', border: 'none', cursor: bulkDetecting ? 'wait' : 'pointer',
                fontSize: '13px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '7px',
                backgroundColor: '#78350f', color: '#fcd34d', opacity: bulkDetecting ? 0.7 : 1
              }}>
              <Brain size={15} />
                {bulkDetecting ? 'Clasificando...' : `Clasificar (${creatives.filter(a => a.media_type === 'image' && (!a.product_line || !a.flavor)).length})`}
              </button>
            )}
            <button onClick={handleOpenGenModal} style={{
              padding: '9px 16px', borderRadius: '10px', border: 'none', cursor: 'pointer',
              fontSize: '13px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '7px',
              backgroundColor: '#581c87', color: '#c084fc'
            }}>
              <Sparkles size={15} />
              Generar con IA
            </button>
            <label style={{
              padding: '9px 16px', borderRadius: '10px', border: 'none', cursor: 'pointer',
              fontSize: '13px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '7px',
              backgroundColor: '#1e3a8a', color: '#93c5fd'
            }}>
              <Upload size={15} />
              Subir Creative
              <input type="file" accept="image/*,video/*" onChange={handleFileSelect} style={{ display: 'none' }} />
            </label>
          </div>
        </div>
      </div>

      {/* ========= STATS BAR ========= */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px', marginBottom: '20px' }}>
        {STYLES.filter(s => s.value !== 'other').map(s => {
          const count = creatives.filter(c => (c.style || 'other') === s.value).length;
          return (
            <div key={s.value} style={{
              backgroundColor: s.color + '10', border: `1px solid ${s.color}25`, borderRadius: '10px',
              padding: '10px 14px', cursor: 'pointer'
            }} onClick={() => setFilter(f => ({ ...f, style: f.style === s.value ? '' : s.value }))}>
              <div style={{ fontSize: '20px', fontWeight: '800', color: s.color }}>{count}</div>
              <div style={{ fontSize: '11px', fontWeight: '600', color: s.color + 'cc' }}>{s.label}</div>
              <div style={{ fontSize: '9px', color: '#4b5563' }}>{s.desc}</div>
            </div>
          );
        })}
      </div>

      {/* ========= FILTERS ========= */}
      <div style={{
        display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center',
        padding: '10px 14px', backgroundColor: '#111827', borderRadius: '10px', border: '1px solid #1f2937'
      }}>
        <Filter size={13} color="#6b7280" />
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: '#4b5563' }} />
          <input
            type="text" placeholder="Buscar..."
            value={filter.search}
            onChange={(e) => setFilter(f => ({ ...f, search: e.target.value }))}
            style={{
              backgroundColor: '#0d1117', color: '#e5e7eb', border: '1px solid #1f2937',
              borderRadius: '6px', padding: '5px 8px 5px 28px', fontSize: '12px', width: '180px'
            }}
          />
        </div>
        {productLines.length > 0 && (
          <select value={filter.product_line} onChange={(e) => setFilter(f => ({ ...f, product_line: e.target.value }))} style={{
            backgroundColor: '#0d1117', color: '#e5e7eb', border: '1px solid #1f2937',
            borderRadius: '6px', padding: '5px 10px', fontSize: '12px'
          }}>
            <option value="">Todas las lineas</option>
            {productLines.map(pl => <option key={pl} value={pl}>{pl}</option>)}
          </select>
        )}
        <select value={filter.purpose} onChange={(e) => setFilter(f => ({ ...f, purpose: e.target.value }))} style={{
          backgroundColor: '#0d1117', color: '#e5e7eb', border: '1px solid #1f2937',
          borderRadius: '6px', padding: '5px 10px', fontSize: '12px'
        }}>
          <option value="">Todos los tipos</option>
          <option value="ad-ready">Ad-Ready</option>
          <option value="reference">Producto Base / Referencia</option>
        </select>
        <select value={filter.style} onChange={(e) => setFilter(f => ({ ...f, style: e.target.value }))} style={{
          backgroundColor: '#0d1117', color: '#e5e7eb', border: '1px solid #1f2937',
          borderRadius: '6px', padding: '5px 10px', fontSize: '12px'
        }}>
          <option value="">Todos los estilos</option>
          {STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filter.usage} onChange={(e) => setFilter(f => ({ ...f, usage: e.target.value }))} style={{
          backgroundColor: '#0d1117', color: '#e5e7eb', border: '1px solid #1f2937',
          borderRadius: '6px', padding: '5px 10px', fontSize: '12px'
        }}>
          <option value="">Todos (uso)</option>
          <option value="unused">Sin usar</option>
          <option value="used">Usados en ads</option>
        </select>
        {(filter.purpose || filter.style || filter.search || filter.usage || filter.product_line) && (
          <button onClick={() => setFilter({ purpose: '', style: '', search: '', usage: '', product_line: '' })} style={{
            padding: '4px 10px', borderRadius: '6px', border: 'none', backgroundColor: '#1f2937',
            color: '#9ca3af', fontSize: '11px', fontWeight: '600', cursor: 'pointer'
          }}>Limpiar</button>
        )}
        {/* View mode toggle */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#4b5563' }}>{filteredCreatives.length} resultados</span>
          <button onClick={() => setViewMode('byProduct')} style={{
            padding: '3px 8px', borderRadius: '5px', border: 'none', fontSize: '10px', fontWeight: '700', cursor: 'pointer',
            backgroundColor: viewMode === 'byProduct' ? '#581c8730' : '#1f2937',
            color: viewMode === 'byProduct' ? '#c084fc' : '#6b7280'
          }}>Por Producto</button>
          <button onClick={() => setViewMode('grid')} style={{
            padding: '3px 8px', borderRadius: '5px', border: 'none', fontSize: '10px', fontWeight: '700', cursor: 'pointer',
            backgroundColor: viewMode === 'grid' ? '#581c8730' : '#1f2937',
            color: viewMode === 'grid' ? '#c084fc' : '#6b7280'
          }}>Grilla</button>
        </div>
      </div>

      {/* ========= BY PRODUCT VIEW (tabs) ========= */}
      {viewMode === 'byProduct' && sortedProductLines.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          {/* ── Product Line Tabs ── */}
          <div style={{
            display: 'flex', gap: '2px', marginBottom: '0', overflowX: 'auto',
            borderBottom: '2px solid #1f2937', paddingBottom: '0'
          }}>
            {sortedProductLines.map(line => {
              const isActive = line === effectiveProductLine;
              const totalInLine = Object.values(groupedByProduct[line]).reduce((s, f) => s + f.reference.length + f.adReady.length, 0);
              return (
                <button key={line} onClick={() => { setActiveProductLine(line); setActiveFlavor(null); }}
                  style={{
                    padding: '8px 16px', border: 'none', borderBottom: isActive ? '2px solid #c084fc' : '2px solid transparent',
                    backgroundColor: isActive ? '#581c8720' : 'transparent',
                    color: isActive ? '#c084fc' : '#6b7280', fontSize: '12px', fontWeight: '700',
                    cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '-2px',
                    borderRadius: '6px 6px 0 0', transition: 'all 0.15s'
                  }}
                >
                  <Package size={11} style={{ marginRight: '5px', verticalAlign: '-1px' }} />
                  {line}
                  <span style={{
                    marginLeft: '6px', padding: '1px 6px', borderRadius: '8px', fontSize: '10px',
                    backgroundColor: isActive ? '#c084fc20' : '#1f2937', color: isActive ? '#c084fc' : '#4b5563'
                  }}>{totalInLine}</span>
                </button>
              );
            })}
          </div>

          {/* ── Flavor Tabs (second row) ── */}
          {effectiveProductLine && sortedFlavors.length > 0 && (
            <div style={{
              display: 'flex', gap: '4px', padding: '8px 10px', flexWrap: 'wrap',
              backgroundColor: '#111827', borderLeft: '1px solid #1f2937', borderRight: '1px solid #1f2937'
            }}>
              {sortedFlavors.map(flav => {
                const isActive = flav === effectiveFlavor;
                const flavAssets = currentFlavors[flav];
                const total = flavAssets.reference.length + flavAssets.adReady.length;
                const feedCount = flavAssets.adReady.filter(a => a.ad_format === 'feed').length;
                const storiesCount = flavAssets.adReady.filter(a => a.ad_format === 'stories').length;
                return (
                  <button key={flav} onClick={() => setActiveFlavor(flav)}
                    style={{
                      padding: '5px 12px', border: `1px solid ${isActive ? '#f59e0b50' : '#1f2937'}`,
                      backgroundColor: isActive ? '#78350f30' : '#0d1117',
                      color: isActive ? '#fcd34d' : '#9ca3af', fontSize: '11px', fontWeight: '600',
                      cursor: 'pointer', borderRadius: '6px', transition: 'all 0.15s',
                      display: 'flex', alignItems: 'center', gap: '5px'
                    }}
                  >
                    <Tag size={10} />
                    {flav}
                    <span style={{
                      fontSize: '9px', padding: '0 4px', borderRadius: '4px',
                      backgroundColor: isActive ? '#f59e0b20' : '#1f293780',
                      color: isActive ? '#fcd34d' : '#4b5563'
                    }}>{total}</span>
                    {isActive && feedCount > 0 && (
                      <span style={{ fontSize: '9px', color: '#3b82f6' }}>{feedCount}F</span>
                    )}
                    {isActive && storiesCount > 0 && (
                      <span style={{ fontSize: '9px', color: '#f59e0b' }}>{storiesCount}S</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Content: selected flavor's assets ── */}
          {effectiveFlavor && (
            <div style={{
              padding: '14px', backgroundColor: '#0d111790',
              border: '1px solid #1f2937', borderTop: 'none', borderRadius: '0 0 10px 10px'
            }}>
              {/* Flavor summary bar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px',
                padding: '6px 10px', backgroundColor: '#161b22', borderRadius: '6px', fontSize: '11px'
              }}>
                <span style={{ fontWeight: '700', color: '#fcd34d' }}>{effectiveFlavor}</span>
                <span style={{ color: '#4b5563' }}>|</span>
                {currentFlavorAssets.reference.length > 0 && (
                  <span style={{ color: '#f59e0b' }}>{currentFlavorAssets.reference.length} base</span>
                )}
                {currentFlavorAssets.adReady.length > 0 && (
                  <span style={{ color: '#10b981' }}>{currentFlavorAssets.adReady.length} ad-ready</span>
                )}
                {(() => {
                  const fc = currentFlavorAssets.adReady.filter(a => a.ad_format === 'feed').length;
                  const sc = currentFlavorAssets.adReady.filter(a => a.ad_format === 'stories').length;
                  const paired = currentFlavorAssets.adReady.filter(a => a.paired_asset_id).length;
                  return (
                    <>
                      {fc > 0 && <span style={{ color: '#3b82f6' }}>{fc} feed (1:1)</span>}
                      {sc > 0 && <span style={{ color: '#f59e0b' }}>{sc} stories (9:16)</span>}
                      {paired > 0 && <span style={{ color: '#c084fc' }}>{Math.floor(paired / 2)} pareados</span>}
                    </>
                  );
                })()}
              </div>

              {/* Reference / Base product images */}
              {currentFlavorAssets.reference.length > 0 && (!filter.purpose || filter.purpose === 'reference') && (
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '10px', fontWeight: '700', color: '#f59e0b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Producto Base
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' }}>
                    {currentFlavorAssets.reference.map(asset => (
                      <AssetCard
                        key={asset._id}
                        asset={asset}
                        compact
                        onPreview={(url, title) => setPreviewImage({ url, title })}
                        onSelect={() => { setSelectedAsset(asset); setEditingAsset({ ...asset }); }}
                        onGenerate={() => { handleOpenGenModal(); setTimeout(() => handleSelectProduct(asset._id), 50); }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Ad-Ready creatives */}
              {currentFlavorAssets.adReady.length > 0 && (!filter.purpose || filter.purpose === 'ad-ready') && (
                <div>
                  <div style={{ fontSize: '10px', fontWeight: '700', color: '#10b981', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Creativos Ad-Ready
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '10px' }}>
                    {currentFlavorAssets.adReady.map(asset => (
                      <AssetCard
                        key={asset._id}
                        asset={asset}
                        onPreview={(url, title) => setPreviewImage({ url, title })}
                        onSelect={() => { setSelectedAsset(asset); setEditingAsset({ ...asset }); }}
                        onUploadMeta={() => handleUploadToMeta(asset._id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {currentFlavorAssets.reference.length === 0 && currentFlavorAssets.adReady.length === 0 && (
                <div style={{ padding: '30px', color: '#4b5563', fontSize: '12px', textAlign: 'center' }}>
                  Sin creativos para este sabor. Sube una imagen base o genera con IA.
                </div>
              )}
            </div>
          )}

          {/* No flavors case */}
          {effectiveProductLine && sortedFlavors.length === 0 && (
            <div style={{
              padding: '30px', textAlign: 'center', color: '#4b5563', fontSize: '12px',
              backgroundColor: '#0d1117', border: '1px solid #1f2937', borderTop: 'none', borderRadius: '0 0 10px 10px'
            }}>
              Sin sabores/variantes para esta linea.
            </div>
          )}
        </div>
      )}

      {/* ========= FLAT GRID VIEW (original) ========= */}
      {viewMode === 'grid' && (
        <>
          {/* PRODUCTOS BASE section */}
          {(!filter.purpose || filter.purpose === 'reference') && products.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Package size={14} color="#f59e0b" />
                <span style={{ fontSize: '13px', fontWeight: '700', color: '#fcd34d' }}>
                  Productos Base ({products.length})
                </span>
                <span style={{ fontSize: '10px', color: '#4b5563' }}>
                  Imagenes reales del producto — se pasan como input a OpenAI
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' }}>
                {products
                  .filter(a => filteredCreatives.some(f => f._id === a._id))
                  .map(asset => (
                  <AssetCard
                    key={asset._id}
                    asset={asset}
                    onPreview={(url, title) => setPreviewImage({ url, title })}
                    onSelect={() => { setSelectedAsset(asset); setEditingAsset({ ...asset }); }}
                    onGenerate={() => { handleOpenGenModal(); setTimeout(() => handleSelectProduct(asset._id), 50); }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* AD-READY section */}
          {(!filter.purpose || filter.purpose === 'ad-ready') && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Layers size={14} color="#10b981" />
                <span style={{ fontSize: '13px', fontWeight: '700', color: '#6ee7b7' }}>
                  Creativos Ad-Ready ({adReady.length})
                </span>
                <span style={{ fontSize: '10px', color: '#4b5563' }}>
                  Listos para usar en campanas de Meta Ads
                </span>
              </div>
              {adReady.length === 0 ? (
                <div style={{
                  padding: '40px', textAlign: 'center', color: '#4b5563', fontSize: '13px',
                  backgroundColor: '#111827', borderRadius: '10px', border: '1px solid #1f2937'
                }}>
                  No hay creativos ad-ready. Genera con IA o sube imagenes.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                  {adReady
                    .filter(a => filteredCreatives.some(f => f._id === a._id))
                    .map(asset => (
                    <AssetCard
                      key={asset._id}
                      asset={asset}
                      onPreview={(url, title) => setPreviewImage({ url, title })}
                      onSelect={() => { setSelectedAsset(asset); setEditingAsset({ ...asset }); }}
                      onUploadMeta={() => handleUploadToMeta(asset._id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {filteredCreatives.length === 0 && (
        <div style={{
          padding: '40px', textAlign: 'center', color: '#4b5563', fontSize: '13px',
          backgroundColor: '#111827', borderRadius: '10px', border: '1px solid #1f2937'
        }}>
          No hay creativos que coincidan con los filtros. Genera con IA o sube imagenes.
        </div>
      )}

      {/* ========= UPLOAD MODAL ========= */}
      {showUploadModal && (
        <ModalOverlay onClose={() => { setShowUploadModal(false); setUploadFile(null); setUploadPreview(null); }}>
          <div style={{ width: '460px', maxWidth: '95vw' }}>
            <ModalHeader icon={<Upload size={16} color="#3b82f6" />} title="Subir Creative" />

            {/* Preview */}
            <div style={{
              height: '200px', backgroundColor: '#0a0a0a', borderRadius: '10px', marginBottom: '14px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              border: '1px solid #1f2937'
            }}>
              {uploadPreview ? (
                <img src={uploadPreview} alt="Preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              ) : (
                <div style={{ color: '#4b5563', fontSize: '12px', textAlign: 'center' }}>
                  <Palette size={28} style={{ marginBottom: '6px' }} />
                  <div>{uploadFile?.name || 'Video'}</div>
                </div>
              )}
            </div>

            {/* Name */}
            <FormField label="Nombre">
              <input type="text" value={uploadMeta.headline} onChange={(e) => setUploadMeta(m => ({ ...m, headline: e.target.value }))}
                style={inputStyle} />
            </FormField>

            {/* Link URL */}
            <FormField label="Link URL (destino del ad)">
              <input type="text" value={uploadMeta.link_url} onChange={(e) => setUploadMeta(m => ({ ...m, link_url: e.target.value }))}
                placeholder="https://tutienda.com/producto" style={inputStyle} />
            </FormField>

            {/* Product Name */}
            <FormField label={uploadMeta.purpose === 'reference' ? 'Nombre del Producto (obligatorio para generar creativos)' : 'Nombre del Producto'}>
              <input type="text" value={uploadMeta.product_name} onChange={(e) => setUploadMeta(m => ({ ...m, product_name: e.target.value }))}
                placeholder={uploadMeta.purpose === 'reference' ? 'Ej: Hot Mild Pickle Salsa' : 'Opcional - IA lo detecta automaticamente'}
                style={{
                  ...inputStyle,
                  borderColor: uploadMeta.purpose === 'reference' && !uploadMeta.product_name ? '#f59e0b40' : inputStyle.borderColor
                }} />
              <div style={{ fontSize: '9px', color: '#6b7280', marginTop: '3px' }}>
                {uploadMeta.purpose === 'reference'
                  ? 'Si lo dejas vacio, la IA lo detectara automaticamente de la imagen (lee la etiqueta del frasco)'
                  : 'La IA detecta el producto, linea y sabor automaticamente si no lo escribes'}
              </div>
            </FormField>

            {/* Product Line + Flavor (side by side) */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <FormField label="Linea de Producto">
                <input type="text" value={uploadMeta.product_line} onChange={(e) => setUploadMeta(m => ({ ...m, product_line: e.target.value }))}
                  placeholder="Ej: Pickle Salsa, Pickles, Olives"
                  style={inputStyle} />
              </FormField>
              <FormField label="Sabor / Variante">
                <input type="text" value={uploadMeta.flavor} onChange={(e) => setUploadMeta(m => ({ ...m, flavor: e.target.value }))}
                  placeholder="Ej: Regular Dill, Hot Mild"
                  style={inputStyle} />
              </FormField>
            </div>

            {/* Purpose */}
            <FormField label="Proposito">
              <div style={{ display: 'flex', gap: '6px' }}>
                {[
                  { value: 'ad-ready', label: 'Ad-Ready', desc: 'Se usa en campanas', color: '#10b981' },
                  { value: 'reference', label: 'Producto Base', desc: 'Imagen real del producto para IA', color: '#f59e0b' }
                ].map(opt => (
                  <button key={opt.value} onClick={() => setUploadMeta(m => ({ ...m, purpose: opt.value }))} style={{
                    flex: 1, padding: '10px', borderRadius: '8px',
                    border: `1px solid ${uploadMeta.purpose === opt.value ? opt.color + '60' : '#1f2937'}`,
                    backgroundColor: uploadMeta.purpose === opt.value ? opt.color + '10' : '#0d1117',
                    cursor: 'pointer', textAlign: 'left'
                  }}>
                    <div style={{ fontSize: '12px', fontWeight: '700', color: uploadMeta.purpose === opt.value ? opt.color : '#9ca3af' }}>{opt.label}</div>
                    <div style={{ fontSize: '10px', color: '#4b5563', marginTop: '2px' }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </FormField>

            {/* Style */}
            <FormField label="Estilo">
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {STYLES.map(s => (
                  <button key={s.value} onClick={() => setUploadMeta(m => ({ ...m, style: s.value }))} style={{
                    padding: '5px 12px', borderRadius: '6px',
                    border: `1px solid ${uploadMeta.style === s.value ? s.color + '60' : '#1f2937'}`,
                    backgroundColor: uploadMeta.style === s.value ? s.color + '15' : '#0d1117',
                    color: uploadMeta.style === s.value ? s.color : '#6b7280',
                    fontSize: '11px', fontWeight: '700', cursor: 'pointer'
                  }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </FormField>

            {/* Ad Format */}
            {uploadMeta.purpose === 'ad-ready' && (
              <FormField label="Formato">
                <div style={{ display: 'flex', gap: '6px' }}>
                  {[
                    { value: 'feed', label: '1:1 Feed', color: '#3b82f6' },
                    { value: 'stories', label: '9:16 Stories', color: '#f59e0b' }
                  ].map(opt => (
                    <button key={opt.value} onClick={() => setUploadMeta(m => ({ ...m, ad_format: opt.value }))} style={{
                      flex: 1, padding: '8px', borderRadius: '8px',
                      border: `1px solid ${uploadMeta.ad_format === opt.value ? opt.color + '60' : '#1f2937'}`,
                      backgroundColor: uploadMeta.ad_format === opt.value ? opt.color + '10' : '#0d1117',
                      cursor: 'pointer', textAlign: 'center'
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: '700', color: uploadMeta.ad_format === opt.value ? opt.color : '#6b7280' }}>{opt.label}</div>
                    </button>
                  ))}
                </div>
              </FormField>
            )}

            {/* Notes */}
            <FormField label="Notas / Descripcion del producto">
              <textarea
                value={uploadMeta.notes}
                onChange={(e) => setUploadMeta(m => ({ ...m, notes: e.target.value }))}
                placeholder="Ej: Pickles artesanales con packaging verde, jar de vidrio..."
                style={{ ...inputStyle, minHeight: '50px', resize: 'vertical' }}
              />
            </FormField>

            {/* Tags */}
            <FormField label="Tags">
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {TAGS_PRESETS.map(tag => (
                  <button key={tag} onClick={() => toggleUploadTag(tag)} style={{
                    padding: '3px 10px', borderRadius: '5px', border: '1px solid #1f2937',
                    backgroundColor: uploadMeta.tags.includes(tag) ? '#1e3a8a' : '#0d1117',
                    color: uploadMeta.tags.includes(tag) ? '#93c5fd' : '#6b7280',
                    fontSize: '11px', fontWeight: '600', cursor: 'pointer'
                  }}>
                    {tag}
                  </button>
                ))}
              </div>
            </FormField>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button onClick={() => { setShowUploadModal(false); setUploadFile(null); setUploadPreview(null); }} style={btnSecondary}>
                Cancelar
              </button>
              <button onClick={handleConfirmUpload} disabled={uploading} style={{
                ...btnPrimary,
                backgroundColor: uploading ? '#374151' : '#1e3a8a',
                color: uploading ? '#6b7280' : '#93c5fd',
                cursor: uploading ? 'not-allowed' : 'pointer'
              }}>
                {uploading ? <Loader size={12} className="spin" /> : <Upload size={12} />}
                {uploading ? 'Subiendo...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ========= ASSET DETAIL MODAL ========= */}
      {selectedAsset && editingAsset && (
        <ModalOverlay onClose={() => { setSelectedAsset(null); setEditingAsset(null); }}>
          <div style={{ width: '600px', maxWidth: '95vw' }}>
            <ModalHeader icon={<Edit3 size={16} color="#c084fc" />} title="Detalle del Creative" />

            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              {/* Image preview */}
              <div style={{
                width: '220px', height: '220px', borderRadius: '10px', overflow: 'hidden',
                backgroundColor: '#0a0a0a', border: '1px solid #1f2937', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-in'
              }} onClick={() => setPreviewImage({ url: getCreativePreviewUrl(selectedAsset.filename), title: selectedAsset.headline || selectedAsset.original_name })}>
                <img src={getCreativePreviewUrl(selectedAsset.filename)} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              </div>

              {/* Edit fields */}
              <div style={{ flex: 1, minWidth: '220px' }}>
                <FormField label="Nombre">
                  <input type="text" value={editingAsset.headline || ''} onChange={(e) => setEditingAsset(p => ({ ...p, headline: e.target.value }))}
                    style={inputStyle} />
                </FormField>

                <FormField label="Producto">
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input type="text" value={editingAsset.product_name || ''} onChange={(e) => setEditingAsset(p => ({ ...p, product_name: e.target.value }))}
                      placeholder="Nombre del producto..." style={{ ...inputStyle, flex: 1 }} />
                    {selectedAsset.media_type === 'image' && (
                      <button onClick={handleDetectProduct} disabled={detectingProduct} style={{
                        padding: '6px 10px', borderRadius: '7px', border: 'none',
                        backgroundColor: detectingProduct ? '#374151' : '#581c8730',
                        color: detectingProduct ? '#6b7280' : '#c084fc',
                        fontSize: '10px', fontWeight: '700', cursor: detectingProduct ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap'
                      }}>
                        {detectingProduct ? <Loader size={10} className="spin" /> : <Brain size={10} />}
                        {detectingProduct ? '...' : 'Detectar'}
                      </button>
                    )}
                  </div>
                  {editingAsset.product_detected_by === 'ai' && (
                    <div style={{ fontSize: '9px', color: '#c084fc', marginTop: '3px' }}>Detectado por IA</div>
                  )}
                </FormField>

                {/* Product Line + Flavor */}
                <div style={{ display: 'flex', gap: '6px' }}>
                  <FormField label="Linea">
                    <input type="text" value={editingAsset.product_line || ''} onChange={(e) => setEditingAsset(p => ({ ...p, product_line: e.target.value }))}
                      placeholder="Ej: Pickle Salsa" style={{ ...inputStyle }} />
                  </FormField>
                  <FormField label="Sabor">
                    <input type="text" value={editingAsset.flavor || ''} onChange={(e) => setEditingAsset(p => ({ ...p, flavor: e.target.value }))}
                      placeholder="Ej: Hot Mild" style={{ ...inputStyle }} />
                  </FormField>
                </div>

                <FormField label="Link URL (destino del ad)">
                  <input type="text" value={editingAsset.link_url || ''} onChange={(e) => setEditingAsset(p => ({ ...p, link_url: e.target.value }))}
                    placeholder="https://tutienda.com/producto" style={inputStyle} />
                </FormField>

                <FormField label="Proposito">
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {['ad-ready', 'reference'].map(p => (
                      <button key={p} onClick={() => setEditingAsset(prev => ({ ...prev, purpose: p }))} style={{
                        padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: '700', cursor: 'pointer',
                        border: `1px solid ${editingAsset.purpose === p ? (p === 'reference' ? '#f59e0b60' : '#10b98160') : '#1f2937'}`,
                        backgroundColor: editingAsset.purpose === p ? (p === 'reference' ? '#f59e0b10' : '#10b98110') : '#0d1117',
                        color: editingAsset.purpose === p ? (p === 'reference' ? '#f59e0b' : '#10b981') : '#6b7280'
                      }}>
                        {p === 'reference' ? 'Producto Base' : 'Ad-Ready'}
                      </button>
                    ))}
                  </div>
                </FormField>

                <FormField label="Estilo">
                  <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                    {STYLES.map(s => (
                      <button key={s.value} onClick={() => setEditingAsset(prev => ({ ...prev, style: s.value }))} style={{
                        padding: '3px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: '700', cursor: 'pointer',
                        border: `1px solid ${editingAsset.style === s.value ? s.color + '60' : '#1f2937'}`,
                        backgroundColor: editingAsset.style === s.value ? s.color + '15' : '#0d1117',
                        color: editingAsset.style === s.value ? s.color : '#6b7280'
                      }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </FormField>

                {/* Ad Format */}
                {editingAsset.purpose === 'ad-ready' && (
                  <FormField label="Formato">
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[
                        { value: 'feed', label: '1:1 Feed', color: '#3b82f6' },
                        { value: 'stories', label: '9:16 Stories', color: '#f59e0b' }
                      ].map(opt => (
                        <button key={opt.value} onClick={() => setEditingAsset(prev => ({ ...prev, ad_format: opt.value }))} style={{
                          padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: '700', cursor: 'pointer',
                          border: `1px solid ${editingAsset.ad_format === opt.value ? opt.color + '60' : '#1f2937'}`,
                          backgroundColor: editingAsset.ad_format === opt.value ? opt.color + '15' : '#0d1117',
                          color: editingAsset.ad_format === opt.value ? opt.color : '#6b7280'
                        }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </FormField>
                )}

                <FormField label="Notas">
                  <textarea value={editingAsset.notes || ''} onChange={(e) => setEditingAsset(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Descripcion del producto, contexto..." style={{ ...inputStyle, minHeight: '50px', resize: 'vertical' }} />
                </FormField>

                <FormField label="Tags">
                  <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                    {TAGS_PRESETS.map(tag => (
                      <button key={tag} onClick={() => setEditingAsset(prev => ({
                        ...prev,
                        tags: (prev.tags || []).includes(tag) ? prev.tags.filter(t => t !== tag) : [...(prev.tags || []), tag]
                      }))} style={{
                        padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '600', cursor: 'pointer',
                        border: '1px solid #1f2937',
                        backgroundColor: (editingAsset.tags || []).includes(tag) ? '#1e3a8a' : '#0d1117',
                        color: (editingAsset.tags || []).includes(tag) ? '#93c5fd' : '#6b7280'
                      }}>
                        {tag}
                      </button>
                    ))}
                  </div>
                </FormField>
              </div>
            </div>

            {/* Ad Set Usage */}
            {selectedAsset.adset_usage && selectedAsset.adset_usage.length > 0 && (
              <div style={{
                padding: '10px 12px', borderRadius: '8px', backgroundColor: '#0d1117',
                border: '1px solid #3b82f620', marginTop: '12px'
              }}>
                <div style={{ fontSize: '10px', fontWeight: '700', color: '#3b82f6', marginBottom: '6px' }}>
                  En {selectedAsset.adset_usage.length} Ad Set(s)
                </div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {selectedAsset.adset_usage.map((u, i) => (
                    <span key={i} style={{
                      padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: '600',
                      backgroundColor: u.status === 'ACTIVE' ? '#10b98110' : u.phase === 'dead' ? '#6b728010' : '#f59e0b10',
                      color: u.status === 'ACTIVE' ? '#10b981' : u.phase === 'dead' ? '#6b7280' : '#f59e0b',
                      display: 'flex', alignItems: 'center', gap: '4px'
                    }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%',
                        backgroundColor: u.status === 'ACTIVE' ? '#10b981' : '#6b7280' }} />
                      {u.name || u.adset_id}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Meta info */}
            <div style={{ display: 'flex', gap: '12px', fontSize: '10px', color: '#4b5563', marginTop: '12px', flexWrap: 'wrap' }}>
              {selectedAsset.generated_by && selectedAsset.generated_by !== 'manual' && (
                <span>Generado por: <span style={{ color: '#a78bfa', fontWeight: '600' }}>{selectedAsset.generated_by}</span></span>
              )}
              {selectedAsset.times_used > 0 && <span>Usado {selectedAsset.times_used}x en ads</span>}
              {selectedAsset.avg_roas > 0 && <span>ROAS prom: <span style={{ color: selectedAsset.avg_roas >= 3 ? '#10b981' : selectedAsset.avg_roas >= 1.5 ? '#f59e0b' : '#ef4444', fontWeight: '600' }}>{selectedAsset.avg_roas.toFixed(1)}x</span></span>}
              {selectedAsset.avg_ctr > 0 && <span>CTR prom: <span style={{ color: selectedAsset.avg_ctr >= 2 ? '#10b981' : selectedAsset.avg_ctr >= 1 ? '#f59e0b' : '#6b7280', fontWeight: '600' }}>{selectedAsset.avg_ctr.toFixed(2)}%</span></span>}
              {selectedAsset.uploaded_to_meta && <span style={{ color: '#10b981' }}>En Meta</span>}
              {selectedAsset.product_name && <span>Producto: <span style={{ color: '#c084fc', fontWeight: '600' }}>{selectedAsset.product_name}</span></span>}
              {selectedAsset.flavor && <span>Sabor: <span style={{ color: '#fcd34d', fontWeight: '600' }}>{selectedAsset.flavor}</span></span>}
              {selectedAsset.paired_asset_id && <span style={{ color: '#c084fc' }}>Pareado ({selectedAsset.ad_format === 'feed' ? '1:1 + 9:16' : '9:16 + 1:1'})</span>}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', marginTop: '16px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                {selectedAsset.purpose !== 'reference' && !selectedAsset.uploaded_to_meta && (
                  <button onClick={() => handleUploadToMeta(selectedAsset._id)} style={{
                    ...btnSecondary, backgroundColor: '#1e3a8a20', color: '#93c5fd', border: '1px solid #1e3a8a40'
                  }}>
                    <ExternalLink size={11} /> Subir a Meta
                  </button>
                )}
                <button onClick={() => handleDeleteCreative(selectedAsset._id)} style={{
                  ...btnSecondary, backgroundColor: '#7f1d1d20', color: '#ef4444', border: '1px solid #7f1d1d40'
                }}>
                  <Trash2 size={11} /> Eliminar
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => { setSelectedAsset(null); setEditingAsset(null); }} style={btnSecondary}>
                  Cancelar
                </button>
                <button onClick={handleSaveAsset} disabled={savingAsset} style={{
                  ...btnPrimary,
                  backgroundColor: savingAsset ? '#374151' : '#581c87',
                  color: savingAsset ? '#6b7280' : '#c084fc'
                }}>
                  {savingAsset ? <Loader size={12} className="spin" /> : <CheckCircle size={12} />}
                  Guardar
                </button>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ========= AI GENERATION MODAL ========= */}
      {showGenModal && (
        <ModalOverlay onClose={handleCloseGenModal}>
          <div style={{ width: genStep === 'preview' ? '1020px' : '600px', maxWidth: '95vw' }}>
            {/* Step indicator bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0', marginBottom: '20px' }}>
              {[
                { key: 'product', num: 1, label: 'Producto' },
                { key: 'references', num: 2, label: 'Referencias' },
                { key: 'config', num: 3, label: 'Estilo' },
                { key: 'prompt', num: 4, label: 'Prompts' }
              ].map((s, idx) => {
                const steps = ['product', 'references', 'config', 'prompt', 'generating', 'preview'];
                const currentIdx = steps.indexOf(genStep);
                const stepIdx = steps.indexOf(s.key);
                const isActive = genStep === s.key;
                const isDone = currentIdx > stepIdx;
                const color = isActive ? '#c084fc' : isDone ? '#10b981' : '#374151';
                return (
                  <React.Fragment key={s.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{
                        width: '26px', height: '26px', borderRadius: '50%',
                        backgroundColor: isDone ? '#10b98130' : isActive ? '#c084fc20' : '#1f2937',
                        border: `2px solid ${color}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '11px', fontWeight: '800', color
                      }}>
                        {isDone ? <CheckCircle size={13} /> : s.num}
                      </div>
                      <span style={{ fontSize: '11px', fontWeight: '600', color, display: idx === 3 && genStep !== 'prompt' ? 'none' : undefined }}>{s.label}</span>
                    </div>
                    {idx < 3 && <div style={{ flex: 1, height: '2px', backgroundColor: isDone ? '#10b98140' : '#1f2937', margin: '0 6px' }} />}
                  </React.Fragment>
                );
              })}
            </div>

            {/* STEP 1: Select Product */}
            {genStep === 'product' && (
              <>
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '15px', fontWeight: '800', color: '#e5e7eb', marginBottom: '4px' }}>
                    Selecciona el producto
                  </div>
                  <div style={{ fontSize: '11px', color: '#6b7280' }}>
                    La IA analizara este producto y generara escenas donde aparezca de forma natural.
                  </div>
                </div>
                {creatives.filter(a => a.media_type === 'image' && a.purpose === 'reference').length === 0 ? (
                  <div style={{ padding: '40px', color: '#6b7280', textAlign: 'center', fontSize: '12px', backgroundColor: '#0d1117', borderRadius: '12px', border: '1px solid #1f2937' }}>
                    No hay productos base en el banco. Sube una foto del producto con proposito "Producto Base" primero.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', maxHeight: '380px', overflowY: 'auto', marginBottom: '14px' }}>
                    {creatives.filter(a => a.media_type === 'image' && a.purpose === 'reference').map(asset => (
                      <button key={asset._id} onClick={() => handleSelectProduct(asset._id)} style={{
                        borderRadius: '12px', overflow: 'hidden', cursor: 'pointer', textAlign: 'left',
                        border: '1px solid #1f2937', backgroundColor: '#0d1117', padding: 0,
                        transition: 'border-color 0.15s, transform 0.1s'
                      }}>
                        <div style={{ height: '110px', backgroundColor: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                          <img src={getCreativePreviewUrl(asset.filename)} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }} />
                        </div>
                        <div style={{ padding: '8px 10px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '700', color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {asset.product_name || asset.headline || asset.original_name}
                          </div>
                          {asset.flavor && <div style={{ fontSize: '9px', color: '#6b7280', marginTop: '2px' }}>{asset.flavor}</div>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={handleCloseGenModal} style={btnSecondary}>Cancelar</button>
                </div>
              </>
            )}

            {/* STEP 2: Select References */}
            {genStep === 'references' && (
              <>
                <ProductMiniPreview
                  asset={creatives.find(c => c._id === genConfig.productId)}
                  onBack={() => setGenStep('product')}
                />

                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '700', color: '#e5e7eb', marginBottom: '4px' }}>
                    Referencias de estilo <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '400' }}>(opcional)</span>
                  </div>
                  <div style={{ fontSize: '10px', color: '#6b7280' }}>
                    Selecciona imagenes que representen el mood o direccion creativa que buscas.
                  </div>
                </div>

                {creatives.filter(a => a.media_type === 'image' && a._id !== genConfig.productId).length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px', maxHeight: '260px', overflowY: 'auto', marginBottom: '12px' }}>
                    {creatives.filter(a => a.media_type === 'image' && a._id !== genConfig.productId).map(asset => {
                      const selected = genConfig.referenceIds.includes(asset._id);
                      return (
                        <button key={asset._id} onClick={() => toggleReference(asset._id)} style={{
                          borderRadius: '10px', overflow: 'hidden', cursor: 'pointer', textAlign: 'left',
                          border: `2px solid ${selected ? '#c084fc' : '#1f2937'}`,
                          backgroundColor: selected ? '#c084fc08' : '#0d1117', padding: 0, position: 'relative',
                          transition: 'border-color 0.15s'
                        }}>
                          {selected && (
                            <div style={{
                              position: 'absolute', top: '5px', right: '5px', zIndex: 1,
                              width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#c084fc',
                              display: 'flex', alignItems: 'center', justifyContent: 'center'
                            }}>
                              <CheckCircle size={12} color="#000" />
                            </div>
                          )}
                          <div style={{ height: '80px', backgroundColor: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                            <img src={getCreativePreviewUrl(asset.filename)} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }} />
                          </div>
                          <div style={{ padding: '4px 6px' }}>
                            <div style={{ fontSize: '9px', fontWeight: '600', color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {asset.headline || asset.original_name}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: '24px', color: '#6b7280', textAlign: 'center', fontSize: '11px', marginBottom: '12px', backgroundColor: '#0d1117', borderRadius: '10px' }}>
                    No hay otras imagenes para usar como referencia.
                  </div>
                )}

                {genConfig.referenceIds.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#c084fc', marginBottom: '10px', fontWeight: '600' }}>
                    {genConfig.referenceIds.length} referencia(s) seleccionada(s)
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button onClick={() => setGenStep('product')} style={btnSecondary}>Volver</button>
                  <button onClick={() => setGenStep('config')} style={btnPurple}>
                    {genConfig.referenceIds.length > 0 ? 'Continuar' : 'Saltar'} <ChevronRight size={12} />
                  </button>
                </div>
              </>
            )}

            {/* STEP 3: Style + Format Config */}
            {genStep === 'config' && (
              <>
                <ProductMiniPreview
                  asset={creatives.find(c => c._id === genConfig.productId)}
                  onBack={() => setGenStep('product')}
                  referenceCount={genConfig.referenceIds.length}
                />

                {/* Style selection */}
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', marginBottom: '8px' }}>Estilo creativo</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                    {STYLES.filter(s => s.value !== 'other').map(s => {
                      const isSelected = genConfig.style === s.value;
                      return (
                        <button key={s.value} onClick={() => setGenConfig(c => ({ ...c, style: s.value }))} style={{
                          padding: '12px 10px', borderRadius: '12px', cursor: 'pointer', textAlign: 'center',
                          border: `2px solid ${isSelected ? s.color : '#1f2937'}`,
                          backgroundColor: isSelected ? s.color + '12' : '#0d1117',
                          transition: 'all 0.15s'
                        }}>
                          <div style={{ fontSize: '18px', marginBottom: '4px' }}>{s.icon}</div>
                          <div style={{ fontSize: '12px', fontWeight: '800', color: isSelected ? s.color : '#9ca3af' }}>{s.label}</div>
                          <div style={{ fontSize: '9px', color: '#6b7280', marginTop: '2px' }}>{s.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Format info */}
                <div style={{
                  padding: '12px 14px', borderRadius: '10px', backgroundColor: '#0d1117',
                  border: '1px solid #1f2937', marginBottom: '14px',
                  display: 'flex', alignItems: 'center', gap: '10px'
                }}>
                  <Layers size={16} color="#c084fc" />
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: '700', color: '#e5e7eb' }}>
                      Dual Format: Feed 1:1 + Stories 9:16
                    </div>
                    <div style={{ fontSize: '10px', color: '#6b7280' }}>
                      3 escenas x 2 formatos = 6 imagenes. La IA crea escenas relevantes al producto.
                    </div>
                  </div>
                </div>

                {/* Instruction */}
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', marginBottom: '6px' }}>
                    Instruccion creativa <span style={{ color: '#4b5563', fontWeight: '400' }}>(opcional)</span>
                  </div>
                  <textarea
                    value={genConfig.instruction}
                    onChange={(e) => setGenConfig(c => ({ ...c, instruction: e.target.value }))}
                    placeholder="Ej: Escena con nachos y amigos, tono de game day, que se vea el producto siendo usado..."
                    style={{ ...inputStyle, minHeight: '70px', resize: 'vertical', borderRadius: '10px', fontSize: '12px', lineHeight: '1.5' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button onClick={() => setGenStep('references')} style={btnSecondary}>Volver</button>
                  <button onClick={handleGeneratePrompt} disabled={genLoading} style={{
                    ...btnPurple,
                    padding: '10px 20px',
                    backgroundColor: genLoading ? '#374151' : '#581c87',
                    color: genLoading ? '#6b7280' : '#c084fc',
                    cursor: genLoading ? 'not-allowed' : 'pointer'
                  }}>
                    {genLoading ? <Loader size={14} className="spin" /> : <Brain size={14} />}
                    {genLoading ? 'Claude pensando...' : 'Generar Escenas'}
                  </button>
                </div>
              </>
            )}

            {/* STEP 4: Review Prompts */}
            {genStep === 'prompt' && genPromptResult && (
              <>
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '700', color: '#e5e7eb', marginBottom: '4px' }}>
                    {genPromptResult.prompts?.length || 0} escenas generadas <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '400' }}>({genPromptResult.generation_time_s}s)</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {(genPromptResult.prompts || []).map((p, i) => (
                      <div key={i} style={{
                        padding: '10px 14px', borderRadius: '10px', backgroundColor: '#0d1117',
                        border: '1px solid #1f2937'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                          <div style={{
                            width: '22px', height: '22px', borderRadius: '6px', backgroundColor: '#c084fc15',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '11px', fontWeight: '800', color: '#c084fc'
                          }}>{i + 1}</div>
                          <span style={{ fontSize: '12px', fontWeight: '700', color: '#e5e7eb' }}>{p.scene_label}</span>
                        </div>
                        <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.5', paddingLeft: '30px' }}>
                          {p.prompt.substring(0, 200)}...
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {genPromptResult.style_rationale && (
                  <div style={{
                    padding: '10px 14px', borderRadius: '10px', backgroundColor: '#0d1117',
                    border: '1px solid #1f2937', marginBottom: '14px'
                  }}>
                    <div style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Razonamiento</div>
                    <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.5' }}>
                      {genPromptResult.style_rationale}
                    </div>
                  </div>
                )}

                {(genPromptResult.suggested_headline || genPromptResult.suggested_body) && (
                  <div style={{ marginBottom: '14px', padding: '10px 14px', borderRadius: '10px', backgroundColor: '#0d1117', border: '1px solid #1f2937' }}>
                    {genPromptResult.suggested_headline && (
                      <div style={{ fontSize: '12px', color: '#e5e7eb', fontWeight: '700', marginBottom: '3px' }}>
                        {genPromptResult.suggested_headline}
                      </div>
                    )}
                    {genPromptResult.suggested_body && (
                      <div style={{ fontSize: '11px', color: '#9ca3af' }}>
                        {genPromptResult.suggested_body}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button onClick={() => setGenStep('config')} style={btnSecondary}>Volver</button>
                  <button onClick={handleGenerateImages} disabled={genLoading} style={{ ...btnPurple, padding: '10px 20px' }}>
                    <Zap size={14} />
                    Generar {(genPromptResult.prompts?.length || 3) * 2} Imagenes
                  </button>
                </div>
              </>
            )}

            {/* STEP: Generating... */}
            {genStep === 'generating' && (
              <div style={{ padding: '60px 30px', textAlign: 'center' }}>
                <div style={{
                  width: '56px', height: '56px', borderRadius: '50%', backgroundColor: '#c084fc15',
                  border: '2px solid #c084fc30', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 18px'
                }}>
                  <Loader size={24} className="spin" color="#c084fc" />
                </div>
                <div style={{ fontSize: '16px', fontWeight: '800', color: '#e5e7eb', marginBottom: '6px' }}>
                  Generando imagenes...
                </div>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '16px' }}>
                  {genPromptResult?.prompts?.length || 3} escenas x 2 formatos = {(genPromptResult?.prompts?.length || 3) * 2} imagenes
                </div>
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap' }}>
                  {(genPromptResult?.prompts || []).map((p, i) => (
                    <span key={i} style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: '600',
                      backgroundColor: '#c084fc10', color: '#c084fc', border: '1px solid #c084fc20'
                    }}>{p.scene_label}</span>
                  ))}
                </div>
                <div style={{ fontSize: '10px', color: '#4b5563', marginTop: '16px' }}>
                  Esto toma ~2-5 minutos. OpenAI genera cada imagen individualmente.
                </div>
              </div>
            )}

            {/* STEP: Preview Results — 6 image grid with judge */}
            {genStep === 'preview' && genImageResults && (() => {
              const product = creatives.find(c => c._id === genConfig.productId);
              const images = genImageResults.images || [];

              // Build ranking map: index -> ranking data
              const rankMap = {};
              if (genJudgeResult?.rankings) {
                genJudgeResult.rankings.forEach(r => { rankMap[r.index] = r; });
              }

              // Medal colors for top 3
              const medalColors = { 1: '#fbbf24', 2: '#94a3b8', 3: '#cd7f32' };
              const medalLabels = { 1: '1ro', 2: '2do', 3: '3ro' };
              const ctrColors = { high: '#10b981', medium: '#f59e0b', low: '#ef4444' };

              return (
                <>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                    <div style={{
                      width: '44px', height: '44px', borderRadius: '10px', overflow: 'hidden',
                      border: '2px solid #1f2937', backgroundColor: '#0a0a0a', flexShrink: 0
                    }}>
                      {product && <img src={getCreativePreviewUrl(product.filename)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '14px', fontWeight: '800', color: '#e5e7eb' }}>
                        {genImageResults.success_count}/{genImageResults.total} imagenes generadas
                      </div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>
                        {genJudging ? 'Claude analizando calidad...' : genJudgeResult ? `Rankeadas por CTR predicho (${genJudgeResult.judge_time_s}s)` : 'Selecciona las que quieras guardar al banco'}
                      </div>
                    </div>
                    {genJudging && <Loader size={18} className="spin" color="#c084fc" />}
                  </div>

                  {/* Judge overall notes */}
                  {genJudgeResult?.overall_notes && (
                    <div style={{
                      padding: '10px 14px', borderRadius: '10px', backgroundColor: '#0d1117', border: '1px solid #1f2937',
                      fontSize: '11px', color: '#c4b5fd', lineHeight: '1.5', marginBottom: '14px'
                    }}>
                      <span style={{ fontWeight: '700', color: '#c084fc' }}>Veredicto: </span>
                      {genJudgeResult.overall_notes}
                    </div>
                  )}

                  {/* Image grid */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px'
                  }}>
                    {images.map((img, i) => {
                      const hasError = !!img.error;
                      const isAccepting = genAccepting.has(img.filename);
                      const isAccepted = genAccepted.has(img.filename);
                      const ranking = rankMap[i];
                      const hasMedal = ranking && ranking.rank <= 3;
                      const borderColor = hasError ? '#7f1d1d' : isAccepted ? '#10b98140' : hasMedal ? medalColors[ranking.rank] + '40' : '#1f2937';

                      return (
                        <div key={i} style={{
                          borderRadius: '12px', overflow: 'hidden',
                          border: `2px solid ${borderColor}`,
                          backgroundColor: '#0d1117', position: 'relative',
                          transition: 'border-color 0.15s'
                        }}>
                          {/* Medal badge */}
                          {hasMedal && (
                            <div style={{
                              position: 'absolute', top: '8px', left: '8px', zIndex: 2,
                              width: '28px', height: '28px', borderRadius: '50%',
                              backgroundColor: medalColors[ranking.rank],
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '10px', fontWeight: '900', color: '#000',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
                            }}>
                              {medalLabels[ranking.rank]}
                            </div>
                          )}

                          {/* Score badge */}
                          {ranking && (
                            <div style={{
                              position: 'absolute', top: '8px', right: '8px', zIndex: 2,
                              padding: '3px 8px', borderRadius: '8px',
                              backgroundColor: '#000000aa',
                              backdropFilter: 'blur(4px)',
                              fontSize: '12px', fontWeight: '900', color: ctrColors[ranking.predicted_ctr]
                            }}>
                              {ranking.score}
                            </div>
                          )}

                          {/* Scene label + format */}
                          <div style={{
                            padding: '8px 10px',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            backgroundColor: '#161b22', borderBottom: '1px solid #21262d'
                          }}>
                            <span style={{ fontSize: '11px', fontWeight: '700', color: '#e5e7eb' }}>
                              {img.scene_label || `Escena ${i + 1}`}
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              {img.ad_format && (
                                <span style={{
                                  padding: '2px 7px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                                  backgroundColor: img.ad_format === 'feed' ? '#3b82f615' : '#f59e0b15',
                                  color: img.ad_format === 'feed' ? '#3b82f6' : '#f59e0b'
                                }}>
                                  {img.ad_format === 'feed' ? '1:1' : '9:16'}
                                </span>
                              )}
                              {!hasError && img.generation_time_s && (
                                <span style={{ fontSize: '9px', color: '#4b5563' }}>{img.generation_time_s}s</span>
                              )}
                            </div>
                          </div>

                          {/* Image */}
                          <div style={{
                            height: img.ad_format === 'stories' ? '220px' : '190px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            backgroundColor: '#0a0a0a'
                          }}>
                            {hasError ? (
                              <div style={{ padding: '16px', textAlign: 'center' }}>
                                <XCircle size={22} color="#ef4444" style={{ marginBottom: '6px' }} />
                                <div style={{ fontSize: '10px', color: '#ef4444', lineHeight: '1.3' }}>{img.error}</div>
                              </div>
                            ) : (
                              <img
                                src={getGeneratedPreviewUrl(img.filename)}
                                alt={img.scene_label}
                                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'zoom-in' }}
                                onClick={() => setPreviewImage({ url: getGeneratedPreviewUrl(img.filename), title: img.scene_label })}
                              />
                            )}
                          </div>

                          {/* Judge verdict */}
                          {ranking && (
                            <div style={{
                              padding: '6px 10px', backgroundColor: '#0d1117', borderTop: '1px solid #21262d',
                              fontSize: '10px', color: '#9ca3af', lineHeight: '1.4'
                            }}>
                              <div style={{ marginBottom: '4px' }}>
                                <span style={{ color: ctrColors[ranking.predicted_ctr], fontWeight: '700' }}>
                                  CTR {ranking.predicted_ctr.toUpperCase()}
                                </span>
                                <span style={{ color: '#4b5563' }}> — </span>
                                <span>{ranking.verdict}</span>
                              </div>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                {[
                                  { label: 'Scroll', val: ranking.scroll_stop, max: 25 },
                                  { label: 'Texto', val: ranking.text_quality, max: 25 },
                                  { label: 'Producto', val: ranking.product_preservation, max: 20 },
                                  { label: 'Escena', val: ranking.scene_authenticity, max: 15 },
                                  { label: 'Emocion', val: ranking.emotional_trigger, max: 15 }
                                ].map(s => (
                                  <span key={s.label} style={{
                                    padding: '2px 5px', borderRadius: '4px', fontSize: '9px', fontWeight: '600',
                                    backgroundColor: (s.val / s.max) > 0.7 ? '#10b98115' : (s.val / s.max) > 0.5 ? '#f59e0b15' : '#ef444415',
                                    color: (s.val / s.max) > 0.7 ? '#10b981' : (s.val / s.max) > 0.5 ? '#f59e0b' : '#ef4444'
                                  }}>
                                    {s.label} {s.val}/{s.max}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Accept button */}
                          {!hasError && (
                            <div style={{ padding: '8px', textAlign: 'center', borderTop: '1px solid #21262d' }}>
                              {isAccepted ? (
                                <div style={{
                                  padding: '7px 12px', borderRadius: '8px',
                                  backgroundColor: '#10b98115', color: '#10b981',
                                  fontSize: '11px', fontWeight: '700',
                                  display: 'flex', alignItems: 'center', gap: '5px', justifyContent: 'center'
                                }}>
                                  <CheckCircle size={12} /> Guardado
                                </div>
                              ) : (
                                <button onClick={() => handleAcceptGenerated(img)} disabled={isAccepting} style={{
                                  padding: '7px 12px', borderRadius: '8px', border: 'none',
                                  backgroundColor: isAccepting ? '#374151' : '#581c87',
                                  color: isAccepting ? '#6b7280' : '#c084fc',
                                  fontSize: '11px', fontWeight: '700',
                                  cursor: isAccepting ? 'not-allowed' : 'pointer',
                                  display: 'inline-flex', alignItems: 'center', gap: '5px', width: '100%', justifyContent: 'center',
                                  transition: 'background-color 0.15s'
                                }}>
                                  {isAccepting ? <Loader size={12} className="spin" /> : <CheckCircle size={12} />}
                                  {isAccepting ? 'Guardando...' : 'Aceptar al banco'}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button onClick={() => setGenStep('prompt')} style={btnSecondary}>Volver</button>
                    <button onClick={handleCloseGenModal} style={btnPurple}>Cerrar</button>
                  </div>
                </>
              );
            })()}
          </div>
        </ModalOverlay>
      )}

      {/* ========= IMAGE LIGHTBOX ========= */}
      {previewImage && (
        <div onClick={() => setPreviewImage(null)} style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: '#000000e6', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2000, cursor: 'zoom-out'
        }}>
          <div style={{ maxWidth: '90vw', maxHeight: '90vh', position: 'relative' }}>
            <img src={previewImage.url} alt={previewImage.title || ''} style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} />
            {previewImage.title && (
              <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '13px', fontWeight: '600', color: '#e5e7eb' }}>
                {previewImage.title}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// =============================================
// SUB-COMPONENTS
// =============================================

const AssetCard = ({ asset, onPreview, onSelect, onGenerate, onUploadMeta, compact }) => {
  const isReference = asset.purpose === 'reference';
  const styleColor = STYLE_COLORS[asset.style || 'other'] || '#6b7280';
  const adsetUsage = asset.adset_usage || [];
  const isUsedInAdSets = adsetUsage.length > 0 || (asset.times_used || 0) > 0;
  const hasPair = !!asset.paired_asset_id;

  return (
    <div style={{
      backgroundColor: '#0d1117',
      border: `1px solid ${isUsedInAdSets ? '#3b82f625' : isReference ? '#f59e0b20' : '#1f2937'}`,
      borderRadius: '10px', overflow: 'hidden', transition: 'border-color 0.15s',
      cursor: 'pointer'
    }} onClick={onSelect}>
      {/* Image */}
      <div style={{
        position: 'relative', height: compact ? '110px' : isReference ? '130px' : '140px',
        backgroundColor: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'
      }}>
        {asset.media_type === 'image' ? (
          <img src={getCreativePreviewUrl(asset.filename)} alt={asset.headline} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ color: '#4b5563', fontSize: '11px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
            <Palette size={22} /> Video
          </div>
        )}

        {/* Purpose badge */}
        <span style={{
          position: 'absolute', top: '5px', left: '5px',
          padding: '2px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: '700',
          backgroundColor: isReference ? '#78350f' : '#065f46', color: isReference ? '#fcd34d' : '#6ee7b7'
        }}>
          {isReference ? 'BASE' : 'AD'}
        </span>

        {/* Style badge */}
        {(asset.style || 'other') !== 'other' && (
          <span style={{
            position: 'absolute', top: '5px', right: '5px',
            padding: '2px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: '700',
            backgroundColor: styleColor + '20', color: styleColor
          }}>
            {asset.style}
          </span>
        )}

        {/* Generated badge */}
        {asset.generated_by && asset.generated_by !== 'manual' && (
          <span style={{
            position: 'absolute', bottom: '5px', right: '5px',
            padding: '2px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: '700',
            backgroundColor: '#8b5cf620', color: '#a78bfa'
          }}>
            {asset.generated_by}
          </span>
        )}

        {/* Format badge */}
        {asset.ad_format && (
          <span style={{
            position: 'absolute', top: '5px', right: (asset.style && asset.style !== 'other') ? '65px' : '5px',
            padding: '2px 5px', borderRadius: '4px', fontSize: '8px', fontWeight: '700',
            backgroundColor: asset.ad_format === 'feed' ? '#3b82f620' : '#f59e0b20',
            color: asset.ad_format === 'feed' ? '#3b82f6' : '#f59e0b'
          }}>
            {asset.ad_format === 'feed' ? '1:1' : '9:16'}
            {hasPair && ' *'}
          </span>
        )}

        {/* Meta badge */}
        {asset.uploaded_to_meta && (
          <span style={{
            position: 'absolute', bottom: '5px', left: '5px',
            padding: '2px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: '700',
            backgroundColor: '#065f4620', color: '#10b981'
          }}>
            Meta
          </span>
        )}

        {/* Used in ad sets badge */}
        {isUsedInAdSets && (
          <span style={{
            position: 'absolute', bottom: '5px', left: asset.uploaded_to_meta ? '50px' : '5px',
            padding: '2px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: '700',
            backgroundColor: '#3b82f620', color: '#93c5fd'
          }}>
            {asset.times_used || adsetUsage.length}x en ads
          </span>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: compact ? '6px 8px' : '8px 10px' }}>
        <div style={{ fontSize: compact ? '11px' : '12px', fontWeight: '600', color: '#e5e7eb', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {asset.headline || asset.original_name}
        </div>
        {/* Flavor tag */}
        {asset.flavor && (
          <div style={{ fontSize: '10px', color: '#fcd34d', fontWeight: '600', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {asset.flavor}
          </div>
        )}
        {/* Product name (only in non-compact or when no flavor) */}
        {!compact && asset.product_name && !asset.flavor && (
          <div style={{ fontSize: '10px', color: '#c084fc', fontWeight: '600', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {asset.product_name}
          </div>
        )}
        {!compact && (
          <div style={{ fontSize: '10px', color: '#4b5563', marginBottom: '4px' }}>
            {asset.media_type}
            {asset.times_used > 0 ? ` | ${asset.times_used}x usado` : ''}
          </div>
        )}
        {/* Performance metrics */}
        {!compact && (asset.avg_roas > 0 || asset.avg_ctr > 0) && (
          <div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
            {asset.avg_roas > 0 && (
              <span style={{
                padding: '1px 5px', borderRadius: '3px', fontSize: '9px', fontWeight: '700',
                backgroundColor: asset.avg_roas >= 3 ? '#10b98115' : asset.avg_roas >= 1.5 ? '#f59e0b15' : '#ef444415',
                color: asset.avg_roas >= 3 ? '#10b981' : asset.avg_roas >= 1.5 ? '#f59e0b' : '#ef4444'
              }}>
                ROAS {asset.avg_roas.toFixed(1)}x
              </span>
            )}
            {asset.avg_ctr > 0 && (
              <span style={{
                padding: '1px 5px', borderRadius: '3px', fontSize: '9px', fontWeight: '700',
                backgroundColor: asset.avg_ctr >= 2 ? '#10b98115' : asset.avg_ctr >= 1 ? '#f59e0b15' : '#6b728015',
                color: asset.avg_ctr >= 2 ? '#10b981' : asset.avg_ctr >= 1 ? '#f59e0b' : '#6b7280'
              }}>
                CTR {asset.avg_ctr.toFixed(1)}%
              </span>
            )}
          </div>
        )}

        {/* Ad set usage labels */}
        {!compact && adsetUsage.length > 0 && (
          <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginBottom: '4px' }}>
            {adsetUsage.slice(0, 2).map((u, i) => (
              <span key={i} style={{
                padding: '1px 6px', borderRadius: '3px', fontSize: '8px', fontWeight: '600',
                backgroundColor: u.status === 'ACTIVE' ? '#10b98110' : '#6b728010',
                color: u.status === 'ACTIVE' ? '#10b981' : '#6b7280',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '120px'
              }}>
                {u.name || u.adset_id}
              </span>
            ))}
            {adsetUsage.length > 2 && (
              <span style={{ fontSize: '8px', color: '#4b5563' }}>+{adsetUsage.length - 2}</span>
            )}
          </div>
        )}

        {!compact && asset.tags && asset.tags.length > 0 && (
          <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
            {asset.tags.slice(0, 3).map(tag => (
              <span key={tag} style={{
                padding: '1px 6px', borderRadius: '3px', fontSize: '9px', fontWeight: '600',
                backgroundColor: '#1e3a8a15', color: '#93c5fd'
              }}>{tag}</span>
            ))}
            {asset.tags.length > 3 && (
              <span style={{ fontSize: '9px', color: '#4b5563' }}>+{asset.tags.length - 3}</span>
            )}
          </div>
        )}

        {/* Quick actions */}
        {isReference && onGenerate && (
          <button onClick={(e) => { e.stopPropagation(); onGenerate(); }} style={{
            marginTop: '6px', padding: '4px 8px', borderRadius: '6px', border: 'none',
            backgroundColor: '#581c87', color: '#c084fc', fontSize: '10px', fontWeight: '700',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', width: '100%', justifyContent: 'center'
          }}>
            <Sparkles size={10} /> Generar variantes
          </button>
        )}
      </div>
    </div>
  );
};

const ProductMiniPreview = ({ asset, onBack, referenceCount }) => {
  if (!asset) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
      borderRadius: '8px', backgroundColor: '#0d1117', border: '1px solid #581c8730', marginBottom: '14px'
    }}>
      <div style={{ width: '48px', height: '48px', borderRadius: '8px', overflow: 'hidden', backgroundColor: '#0a0a0a', flexShrink: 0 }}>
        <img src={getCreativePreviewUrl(asset.filename)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      <div>
        <div style={{ fontSize: '12px', fontWeight: '700', color: '#c084fc' }}>Producto seleccionado</div>
        <div style={{ fontSize: '10px', color: '#9ca3af' }}>
          {asset.headline || asset.original_name}
          {referenceCount > 0 && <span style={{ color: '#f59e0b' }}> + {referenceCount} ref(s)</span>}
        </div>
      </div>
      <button onClick={onBack} style={{
        marginLeft: 'auto', padding: '3px 8px', borderRadius: '4px', border: 'none',
        backgroundColor: '#1f2937', color: '#6b7280', fontSize: '10px', fontWeight: '600', cursor: 'pointer'
      }}>Cambiar</button>
    </div>
  );
};

const ModalOverlay = ({ children, onClose }) => (
  <div onClick={onClose} style={{
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#000000cc', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000
  }}>
    <div onClick={(e) => e.stopPropagation()} style={{
      backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '14px',
      padding: '22px', maxHeight: '90vh', overflowY: 'auto'
    }}>
      {children}
    </div>
  </div>
);

const ModalHeader = ({ icon, title, badge }) => (
  <div style={{
    fontSize: '16px', fontWeight: '700', color: '#e5e7eb', marginBottom: '16px',
    display: 'flex', alignItems: 'center', gap: '8px'
  }}>
    {icon}
    {title}
    {badge && (
      <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#6b7280', fontWeight: '600' }}>
        Paso {badge}
      </span>
    )}
  </div>
);

const FormField = ({ label, children }) => (
  <div style={{ marginBottom: '12px' }}>
    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '5px' }}>
      {label}
    </label>
    {children}
  </div>
);

// =============================================
// SHARED STYLES
// =============================================

const inputStyle = {
  width: '100%', padding: '7px 10px', borderRadius: '7px', border: '1px solid #1f2937',
  backgroundColor: '#0d1117', color: '#e5e7eb', fontSize: '12px', boxSizing: 'border-box',
  fontFamily: 'inherit'
};

const btnSecondary = {
  padding: '7px 14px', borderRadius: '8px', border: 'none', backgroundColor: '#1f2937',
  color: '#9ca3af', fontSize: '12px', fontWeight: '700', cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: '5px'
};

const btnPrimary = {
  padding: '7px 14px', borderRadius: '8px', border: 'none',
  fontSize: '12px', fontWeight: '700', cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: '5px'
};

const btnPurple = {
  padding: '7px 14px', borderRadius: '8px', border: 'none',
  backgroundColor: '#581c87', color: '#c084fc',
  fontSize: '12px', fontWeight: '700', cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: '5px'
};

export default CreativeBank;
