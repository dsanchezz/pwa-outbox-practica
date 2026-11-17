/* app.js - Lógica de UI, envío resiliente (Outbox) y reconexión.
 * Sin async/await ni librerías: solo Promesas explícitas.
 */
const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

const formIncidencia = document.getElementById('form-incidencia');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');

// ---------- Service Worker + puente postMessage (Fragmento G) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
      .catch((err) => console.error('[SW] Error de registro:', err));
  });
}

// ---------- Detalle de una incidencia (modal de Bootstrap) ----------
function formatearFecha(ms) {
  return ms ? new Date(ms).toLocaleString('es-MX') : '—';
}

function mostrarDetalleIncidencia(item) {
  const sincronizado = item.estado === 'sincronizado';
  document.getElementById('detalle-titulo').textContent = item.titulo;
  document.getElementById('detalle-descripcion').textContent = item.descripcion;
  document.getElementById('detalle-id').textContent = '#' + item.id;
  document.getElementById('detalle-creada').textContent = formatearFecha(item.fechaCreacion);
  document.getElementById('detalle-sincronizada').textContent =
    sincronizado ? formatearFecha(item.fechaSincronizacion) : 'Aún no sincronizada';

  const badge = document.getElementById('detalle-estado');
  badge.textContent = item.estado;
  badge.className = 'badge text-uppercase ' + (sincronizado ? 'text-bg-secondary' : 'text-bg-warning');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-detalle')).show();
}

// ---------- READ: dibujar la bandeja de salida ----------
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      listaOutbox.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'list-group-item text-center text-body-secondary';
        vacio.textContent = 'La bandeja está vacía.';
        listaOutbox.appendChild(vacio);
        return;
      }

      registros
        .sort((a, b) => b.fechaCreacion - a.fechaCreacion)
        .forEach((item) => {
          const li = document.createElement('li');
          const sincronizado = item.estado === 'sincronizado';
          li.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ' +
            (sincronizado ? 'list-group-item-light border' : 'list-group-item-warning');
          li.tabIndex = 0;
          li.setAttribute('role', 'button');
          li.addEventListener('click', () => mostrarDetalleIncidencia(item));
          li.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              mostrarDetalleIncidencia(item);
            }
          });

          const info = document.createElement('div');
          const titulo = document.createElement('div');
          titulo.className = 'fw-semibold';
          titulo.textContent = item.titulo;
          const meta = document.createElement('small');
          meta.className = 'text-body-secondary';
          meta.textContent = new Date(item.fechaCreacion).toLocaleString('es-MX');
          info.appendChild(titulo);
          info.appendChild(meta);

          const estado = document.createElement('span');
          estado.className = 'badge text-uppercase ' + (sincronizado ? 'text-bg-secondary' : 'text-bg-warning');
          estado.textContent = item.estado;

          li.appendChild(info);
          li.appendChild(estado);
          listaOutbox.appendChild(li);
        });
    })
    .catch((error) => console.error('[Outbox] Error al leer la bandeja:', error));
}

// ---------- CREATE: envío resiliente con fallback a IndexedDB ----------
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: datosFormulario.titulo, body: datosFormulario.descripcion })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => {
          // Background Sync: delegar el reenvío al Service Worker
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready
              .then((registro) => {
                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                return registro.sync.register('sync-reportes');
              });
          }
        });
    })
    .then(() => renderizarColaOutbox());
}

// ---------- UPDATE (fallback sin SyncManager): barrido y reenvío ----------
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

// ---------- Eventos de red ----------
window.addEventListener('online', () => {

  // Degradación elegante: solo sincronizar desde la UI si NO hay Background Sync (Safari/iOS, Firefox).
  // En Chrome lo hace sw.js; hacerlo aquí también duplicaría los POST (condición de carrera).
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', () => console.warn('[Outbox] Conexión perdida. Los reportes se encolarán localmente.'));

// ---------- Formulario (submit) ----------
formIncidencia.addEventListener('submit', (e) => {
  e.preventDefault();

  const titulo = document.getElementById('titulo').value.trim();
  const descripcion = document.getElementById('descripcion').value.trim();
  if (!titulo || !descripcion) return;

  procesarEnvioReporte({ titulo, descripcion })
    .then(() => formIncidencia.reset());
});

// ---------- DELETE: purgar sincronizados ----------
btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => console.error('[Outbox] Error al purgar:', error));
});

// ---------- Arranque: READ inicial (rescata los registros guardados) ----------
renderizarColaOutbox().then(() => {
  // Si la pestaña se abrió con red y quedaron pendientes en un navegador sin SyncManager
  if (navigator.onLine && !('SyncManager' in window)) {
    return sincronizarPendientesFallback();
  }
});
