import { useEffect, useMemo, useRef, useState } from 'react';
import PB from './img/PB.jpeg';
import escudo from './img/CARCANCHO-FINAL.png';
import mi_caja from './img/mi_caja.jpeg';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_FILES = 10;
const DEFAULT_WATERMARK_TEXT = 'POLICIA BOLIVIANA';
const PAGE_SIZE = 10;
const RETENTION_PRESETS = [
  { value: '1', label: '1 día' },
  { value: '7', label: '7 días' },
  { value: '15', label: '15 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
  { value: '180', label: '180 días' },
  { value: '365', label: '1 año' },
  { value: 'custom', label: 'Personalizado…' },
];

function readableSize(size) {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const position = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** position).toFixed(position ? 1 : 0)} ${units[position]}`;
}

function messageFrom(response, fallback) {
  return response
    .json()
    .then((payload) => {
      const message = Array.isArray(payload.message) ? payload.message.join(' ') : payload.message;
      return message || fallback;
    })
    .catch(() => fallback);
}

function normaliseSearch(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isPdf(file) {
  const name = file?.name || file?.fileName || '';
  return (
    file?.type === 'application/pdf' ||
    file?.contentType === 'application/pdf' ||
    name.toLowerCase().endsWith('.pdf')
  );
}

function fileExtension(fileName) {
  const name = fileName || '';
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1 || lastDot === name.length - 1) return 'sin-extension';
  return name.slice(lastDot + 1).toLowerCase();
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-BO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/* ---------- Iconos en línea (sin dependencias externas) ---------- */
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9 7V4.6C9 4 9.4 3.5 10 3.5h4c.6 0 1 .5 1 1.1V7" />
      <path d="M6 7l1 12.3c0 .9.7 1.7 1.7 1.7h6.6c1 0 1.7-.8 1.7-1.7L18 7" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5l8 3v5.6c0 5-3.4 8.4-8 10.4-4.6-2-8-5.4-8-10.4V5.5l8-3Z" />
      <path d="M8.4 12.2l2.4 2.4 4.8-4.8" />
    </svg>
  );
}
/* ------------------------------------------------------------------ */

export default function App() {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [storedFiles, setStoredFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [extensionFilter, setExtensionFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [storeOriginalPdf, setStoreOriginalPdf] = useState(false);
  const [watermarkText, setWatermarkText] = useState(DEFAULT_WATERMARK_TEXT);
  const [retentionMode, setRetentionMode] = useState('permanent');
  const [retentionPreset, setRetentionPreset] = useState('30');
  const [retentionCustomDays, setRetentionCustomDays] = useState('30');
  const inputRef = useRef(null);

  const selectedPdfFiles = selectedFiles.filter(isPdf);
  const effectiveRetentionDays =
    retentionPreset === 'custom' ? retentionCustomDays : retentionPreset;

  const availableExtensions = useMemo(() => {
    const set = new Set(storedFiles.map((file) => fileExtension(file.fileName)));
    return Array.from(set).sort();
  }, [storedFiles]);

  const filteredFiles = useMemo(() => {
    const term = normaliseSearch(searchTerm.trim());
    return storedFiles.filter((file) => {
      const matchesTerm = !term || normaliseSearch(`${file.fileName} ${file.contentType}`).includes(term);
      const matchesExtension =
        extensionFilter === 'all' || fileExtension(file.fileName) === extensionFilter;
      return matchesTerm && matchesExtension;
    });
  }, [storedFiles, searchTerm, extensionFilter]);
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, extensionFilter]);

  const totalItems = filteredFiles.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, totalItems);
  const pageFiles = filteredFiles.slice(startIndex, endIndex);

  const refreshFiles = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/files');
      if (!response.ok) throw new Error(await messageFrom(response, 'No se pudo consultar el archivo.'));
      setStoredFiles(await response.json());
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refreshFiles();
  }, []);

  const selectFiles = (incoming) => {
    const candidates = Array.from(incoming || []);
    const tooLarge = candidates.find((file) => file.size > MAX_FILE_SIZE);
    if (tooLarge) {
      setNotice({ type: 'error', text: `${tooLarge.name} supera el límite de 50 MB.` });
      return;
    }
    const chosen = candidates.slice(0, MAX_FILES);
    if (!chosen.length) return;
    setSelectedFiles(chosen);
    setStoreOriginalPdf(false);
    setWatermarkText(DEFAULT_WATERMARK_TEXT);
    setRetentionMode('permanent');
    setRetentionPreset('30');
    setRetentionCustomDays('30');
    setNotice(
      candidates.length > MAX_FILES
        ? { type: 'error', text: `Solo se prepararon los primeros ${MAX_FILES} archivos.` }
        : null,
    );
  };

  const upload = async () => {
    if (!selectedFiles.length || isUploading) return;
    if (selectedPdfFiles.length && !storeOriginalPdf && !watermarkText.trim()) {
      setNotice({ type: 'error', text: 'Ingrese el texto de la marca de agua para los PDF.' });
      return;
    }
    if (retentionMode === 'temporary') {
      const days = Number(effectiveRetentionDays);
      if (!Number.isFinite(days) || days < 1 || days > 3650) {
        setNotice({ type: 'error', text: 'Indique un lapso de conservación válido (entre 1 y 3650 días).' });
        return;
      }
    }
    setIsUploading(true);
    setNotice(null);
    const body = new FormData();
    selectedFiles.forEach((file) => body.append('files', file));
    if (selectedPdfFiles.length) {
      body.append('pdfMode', storeOriginalPdf ? 'original' : 'watermarked');
      if (!storeOriginalPdf) body.append('watermarkText', watermarkText.trim());
    }
    body.append('retentionMode', retentionMode);
    if (retentionMode === 'temporary') {
      body.append('retentionDays', String(effectiveRetentionDays));
    }

    try {
      const response = await fetch('/api/files', { method: 'POST', body });
      if (!response.ok) throw new Error(await messageFrom(response, 'La carga no pudo completarse.'));
      const result = await response.json();
      const protectedCount = result.filter((file) => file.watermarked).length;
      setSelectedFiles([]);
      setStoreOriginalPdf(false);
      setWatermarkText(DEFAULT_WATERMARK_TEXT);
      setRetentionMode('permanent');
      setRetentionPreset('30');
      setRetentionCustomDays('30');
      if (inputRef.current) inputRef.current.value = '';
      setNotice({
        type: 'success',
        text: `${result.length} archivo(s) almacenado(s). ${protectedCount ? `${protectedCount} PDF(s) protegidos con marca de agua.` : selectedPdfFiles.length ? `${selectedPdfFiles.length} PDF(s) originales almacenados sin marca.` : ''}`,
      });
      await refreshFiles();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setIsUploading(false);
    }
  };

  const remove = async (file) => {
    if (!window.confirm(`¿Eliminar «${file.fileName}» de MinIO?`)) return;
    setNotice(null);
    try {
      const response = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await messageFrom(response, 'No se pudo eliminar el archivo.'));
      setStoredFiles((current) => current.filter((item) => item.id !== file.id));
      setNotice({ type: 'success', text: 'Archivo eliminado correctamente.' });
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark" aria-label="Logo Policía Boliviana">
          <img src={mi_caja} alt="Escudo Policía Boliviana" />
        </div>
        <div>
          <p className="eyebrow">Policía Boliviana</p>
          <h1>Archivo digital seguro</h1>
        </div>
        {/*<div className="system-status"><span /> --- </div> */}
      </header>

      <section className="hero">
        <div className="hero-heading">
          <div className="hero-logo" aria-hidden="true">
            <img src={escudo} alt="" />
          </div>
          <div>
            <p className="eyebrow">Gestión documental</p>
            <h2>Resguardo de archivos.</h2>
            <p className="lead">Los documentos PDF pueden guardarse como originales o con una marca de agua personalizada. Los demás formatos se almacenan sin modificaciones.</p>
          </div>
        </div>
        {/*<div className="protection-card">
          <span className="shield">⌾</span>
          <div><strong>Protección PDF activa</strong><small>Stirling PDF + marca de agua</small></div>
        </div> */}
      </section>

      <section className="workspace" aria-label="Carga de archivos">
        <div
          className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); selectFiles(event.dataTransfer.files); }}
        >
          <input ref={inputRef} id="file-input" type="file" multiple onChange={(event) => selectFiles(event.target.files)} />
          <div className="upload-symbol" aria-hidden="true">↑</div>
          <h3>Arrastre los archivos aquí</h3>
          <p>o seleccione desde el equipo. Se admiten todos los formatos.</p>
          <label className="secondary-button" htmlFor="file-input">Seleccionar archivos</label>
          <small>Máximo {MAX_FILES} archivos por carga · 50 MB por archivo · Compresión automática sin pérdida de calidad</small>
        </div>

        <aside className="selection-panel">
          <div className="panel-heading"><h3>Preparados para enviar</h3><span>{selectedFiles.length}/{MAX_FILES}</span></div>
          {selectedFiles.length ? (
            <ul className="selection-list">
              {selectedFiles.map((file) => (
                <li key={`${file.name}-${file.lastModified}`}><span className="file-icon">{isPdf(file) ? 'PDF' : 'FILE'}</span><div><strong>{file.name}</strong><small>{readableSize(file.size)} {isPdf(file) && `· ${storeOriginalPdf ? 'original sin marca' : 'con marca personalizada'}`}</small></div></li>
              ))}
            </ul>
          ) : <p className="empty-state">Aún no hay archivos seleccionados.</p>}

          {selectedPdfFiles.length > 0 && (
            <fieldset className="pdf-options">
              <legend>Opciones para {selectedPdfFiles.length} PDF{selectedPdfFiles.length > 1 ? 's' : ''}</legend>
              <label className="checkbox-option">
                <input type="checkbox" checked={storeOriginalPdf} onChange={(event) => setStoreOriginalPdf(event.target.checked)} disabled={isUploading} />
                <span><strong>Almacenar PDF original (sin marca de agua)</strong><small>Al desmarcarlo, se aplicará una marca de agua personalizada.</small></span>
              </label>
              {!storeOriginalPdf && (
                <label className="watermark-input">
                  <span>Personalizar marca de agua</span>
                  <input type="text" value={watermarkText} onChange={(event) => setWatermarkText(event.target.value)} maxLength="120" disabled={isUploading} aria-label="Texto de la marca de agua" />
                </label>
              )}
            </fieldset>
          )}

          {selectedFiles.length > 0 && (
            <fieldset className="retention-options">
              <legend>Tiempo de conservación</legend>
              <p className="retention-hint">Defina si el/los archivo(s) permanecerán almacenados de forma permanente o solo por un lapso de tiempo, para resguardar la privacidad de la información.</p>
              <label className="radio-option">
                <input
                  type="radio"
                  name="retentionMode"
                  value="permanent"
                  checked={retentionMode === 'permanent'}
                  onChange={() => setRetentionMode('permanent')}
                  disabled={isUploading}
                />
                <span><strong>Conservar permanentemente</strong><small>El sistema lo almacena, sin ningún cambio.</small></span>
              </label>
              <label className="radio-option">
                <input
                  type="radio"
                  name="retentionMode"
                  value="temporary"
                  checked={retentionMode === 'temporary'}
                  onChange={() => setRetentionMode('temporary')}
                  disabled={isUploading}
                />
                <span><strong>Conservar temporalmente</strong><small>El archivo se elimina automáticamente al vencer el plazo elegido.</small></span>
              </label>

              {retentionMode === 'temporary' && (
                <div className="retention-duration">
                  <label className="retention-select">
                    <span>Plazo de conservación</span>
                    <select
                      value={retentionPreset}
                      onChange={(event) => setRetentionPreset(event.target.value)}
                      disabled={isUploading}
                    >
                      {RETENTION_PRESETS.map((preset) => (
                        <option key={preset.value} value={preset.value}>{preset.label}</option>
                      ))}
                    </select>
                  </label>
                  {retentionPreset === 'custom' && (
                    <label className="retention-select">
                      <span>Cantidad de días</span>
                      <input
                        type="number"
                        min="1"
                        max="3650"
                        value={retentionCustomDays}
                        onChange={(event) => setRetentionCustomDays(event.target.value)}
                        disabled={isUploading}
                      />
                    </label>
                  )}
                </div>
              )}
            </fieldset>
          )}

          <button className="primary-button" type="button" onClick={upload} disabled={!selectedFiles.length || isUploading}>
            {isUploading ? 'Procesando y guardando…' : 'Subir al archivo seguro'}
          </button>
        </aside>
      </section>

      {notice && <p className={`notice ${notice.type}`} role="status">{notice.text}</p>}

      <section className="archive-section" aria-label="Archivos almacenados">
        <div className="section-heading">
          <div><p className="eyebrow">MinIO S3 privado</p><h2>Archivos almacenados</h2></div>
          <div className="archive-tools">
            <select
              className="file-filter"
              value={extensionFilter}
              onChange={(event) => setExtensionFilter(event.target.value)}
              aria-label="Filtrar por categoría o extensión"
            >
              <option value="all">Todas las categorías</option>
              {availableExtensions.map((extension) => (
                <option key={extension} value={extension}>.{extension}</option>
              ))}
            </select>
            <input className="file-search" type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Buscar por nombre o formato" aria-label="Buscar archivos almacenados" />
            <button className="icon-button" type="button" onClick={refreshFiles} disabled={isLoading} aria-label="Actualizar lista">↻</button>
          </div>
        </div>

        {isLoading ? <p className="empty-state">Actualizando el archivo…</p> : storedFiles.length ? (
          filteredFiles.length ? (
            <>
              <div className="file-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Archivo</th>
                      <th>Protección</th>
                      <th>Conservación</th>
                      <th>Tamaño</th>
                      <th>Fecha</th>
                      <th aria-label="Acciones" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageFiles.map((file) => (
                      <tr key={file.id}>
                        <td><strong>{file.fileName}</strong><small>{file.contentType}</small></td>
                        <td>
                          {file.watermarked ? (
                            <span className="badge protected">PDF con marca</span>
                          ) : isPdf(file) ? (
                            <span className="badge">PDF original</span>
                          ) : (
                            <span className="badge">Almacenado</span>
                          )}
                        </td>
                        <td>
                          {file.retention === 'temporary' ? (
                            <span className="badge temporal"><ClockIcon /> Vence {file.expiresAt ? formatDate(file.expiresAt) : '—'}</span>
                          ) : (
                            <span className="badge permanent"><ShieldIcon /> Permanente</span>
                          )}
                        </td>
                        <td>{readableSize(file.size)}{file.compressed && <small className="compressed-hint">Comprimido sin pérdida</small>}</td>
                        <td>{formatDate(file.uploadedAt)}</td>
                        <td className="actions">
                          <a
                            className="action-btn action-view"
                            href={file.viewUrl || `${file.downloadUrl}?disposition=inline`}
                            target="_blank"
                            rel="noreferrer"
                            title="Ver archivo"
                          >
                            <EyeIcon />{/*<span>Ver</span>*/}
                          </a>
                          <a className="action-btn action-download" href={file.downloadUrl} title="Descargar">
                            <DownloadIcon />{/*<span>Decargar</span>*/}
                          </a>
                          <button type="button" className="action-btn action-delete" onClick={() => remove(file)} title="Eliminar">
                            <TrashIcon />{/*<span>Eliminar</span>*/}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination" aria-label="Paginación de archivos almacenados">
                <p className="pagination-count">
                  Mostrando {totalItems === 0 ? 0 : startIndex + 1} - {endIndex} de {totalItems} archivos
                </p>
                <div className="pagination-controls">
                  <button
                    type="button"
                    className="pagination-button"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={safePage <= 1}
                  >
                    ← Anterior
                  </button>
                  <span className="pagination-page">Página {safePage} de {totalPages}</span>
                  <button
                    type="button"
                    className="pagination-button"
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    disabled={safePage >= totalPages}
                  >
                    Siguiente →
                  </button>
                </div>
              </div>
            </>
          ) : <p className="empty-state">No se encontraron archivos que coincidan con la búsqueda o el filtro.</p>
        ) : <p className="empty-state">No hay archivos en el repositorio todavía.</p>}
      </section>
      <footer className="footer-system">
        <div className="footer-content">
          <div>
            <p className="footer-brand">Policía Boliviana Tecnología y Telemática</p>
            <p className="footer-text">
              Sistema de Gestión Documental y Archivo Digital.
            </p>
          </div>
          <div className="footer-meta">
            <span className="footer-badge">Versión 1.0.0</span>
            <p className="footer-copyright">
              © 2026 Todos los derechos reservados.
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
