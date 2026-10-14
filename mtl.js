(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    mode: "demo",
    interval: null,
    lastReading: null,
    previousAlert: false,
    location: null,
    toastTimeout: null,
    demoTick: 0,
    history: []
  };

  const thresholds = { full: 85, gasWarning: 55, gasDanger: 70 };
  const savedEndpoint = localStorage.getItem("wp2-api-url") || localStorage.getItem("ruangbersih-api-url") || "";
  const endpoint = new URLSearchParams(location.search).get("api");

  const formatDate = (date) => new Intl.DateTimeFormat("id-ID", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(date);

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(state.toastTimeout);
    state.toastTimeout = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function setStatusPill(el, text, level) {
    el.textContent = text;
    el.className = `status-pill ${level}`;
  }

  function normalizeReading(raw) {
    const data = raw && raw.data && typeof raw.data === "object" ? raw.data : raw;
    if (!data || typeof data !== "object") throw new Error("Respons API harus berupa objek JSON.");
    const numberOrNull = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const binHeight = numberOrNull(data.binHeightCm);
    const distance = numberOrNull(data.distanceCm);
    let fill = numberOrNull(data.fillPct);
    if (fill === null && Number.isFinite(binHeight) && binHeight > 0 && Number.isFinite(distance)) {
      fill = ((binHeight - distance) / binHeight) * 100;
    }
    let gas = numberOrNull(data.gasIndex);
    let gasSource = "Indeks gas relatif";
    const mq135Raw = numberOrNull(data.mq135Raw);
    if (gas === null && Number.isFinite(mq135Raw)) {
      gas = (mq135Raw / 1023) * 100;
      gasSource = `MQ-135 mentah ${Math.round(mq135Raw)}/1023 · relatif`;
    }
    if (!Number.isFinite(fill) || !Number.isFinite(gas)) {
      throw new Error("Data wajib berisi fillPct atau distanceCm + binHeightCm, dan gasIndex atau mq135Raw.");
    }
    const temperature = numberOrNull(data.temperatureC);
    const humidity = numberOrNull(data.humidityPct);
    return {
      fill: Math.max(0, Math.min(100, fill)),
      distance: Number.isFinite(distance) ? distance : null,
      gas: Math.max(0, Math.min(100, gas)),
      gasSource,
      temperature: Number.isFinite(temperature) ? temperature : null,
      humidity: Number.isFinite(humidity) ? humidity : null,
      timestamp: data.timestamp && Number.isFinite(new Date(data.timestamp).getTime()) ? new Date(data.timestamp) : new Date(),
      latitude: numberOrNull(data.latitude),
      longitude: numberOrNull(data.longitude)
    };
  }

  function updateLocation(lat, lon, source) {
    state.location = { lat, lon };
    $("location-status").textContent = source === "sensor" ? "Lokasi dari perangkat IoT" : "Lokasi dari GPS browser";
    $("location-coordinates").textContent = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
    $("location-updated").textContent = `Lokasi diperbarui ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    $("location-updated").previousElementSibling.classList.add("live");
    $("map-pin").classList.add("visible");
    $("map-caption").textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const mapLink = $("map-link");
    mapLink.href = `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}`;
    mapLink.classList.remove("disabled");
  }

  function requestGps(automatic) {
    if (!navigator.geolocation) {
      if (!automatic) toast("Browser ini tidak mendukung GPS.");
      $("location-status").textContent = "Browser tidak mendukung GPS";
      return;
    }
    $("location-status").textContent = "Menunggu izin dan sinyal GPS…";
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        updateLocation(coords.latitude, coords.longitude, "browser");
        if (!automatic) toast("Lokasi GPS berhasil diperbarui.");
      },
      (error) => {
        const messages = {
          1: "Izin lokasi ditolak. Aktifkan izin lokasi pada browser.",
          2: "Lokasi belum tersedia. Periksa GPS atau koneksi perangkat.",
          3: "Permintaan lokasi habis waktu. Coba aktifkan kembali."
        };
        $("location-status").textContent = messages[error.code] || "Lokasi gagal diperbarui.";
        if (!automatic) toast(messages[error.code] || "Lokasi gagal diperbarui.");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  function updateSchedule(reading, dangerous) {
    const pickup = new Date(Date.now() + 30 * 60 * 1000);
    $("schedule-day").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "short" }).format(pickup).toUpperCase();
    $("schedule-date-number").textContent = pickup.getDate();
    $("schedule-title").textContent = dangerous ? "Pengangkutan prioritas" : "Pengecekan rutin";
    $("schedule-description").textContent = dangerous
      ? (reading.fill >= thresholds.full ? "Volume sampah mencapai batas penuh." : "Indeks gas melewati batas aman.")
      : "Jadwal akan menyesuaikan kondisi sensor.";
    $("schedule-time").textContent = dangerous
      ? `Disarankan sekitar ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(pickup)}`
      : "08.00 – 10.00";
    $("schedule-list").innerHTML = dangerous
      ? `<div class="schedule-row"><span class="schedule-dot" style="background:#e59555"></span><div><strong>Pengangkutan prioritas</strong><small>${reading.fill >= thresholds.full ? "Tempat sampah hampir/penuh" : "Indikasi indeks gas tinggi"} · 30 menit</small></div><span class="schedule-tag urgent">Prioritas</span></div>`
      : '<div class="schedule-row"><span class="schedule-dot"></span><div><strong>Pengangkutan rutin</strong><small>Menunggu data lokasi perangkat</small></div><span class="schedule-tag">Rutin</span></div>';
    $("schedule-note").textContent = dangerous
      ? "Rekomendasi otomatis; konfirmasi petugas pengangkut tetap diperlukan."
      : "Jadwal otomatis dibuat saat volume ≥ 85% atau indeks gas ≥ 70.";
    $("nav-count").textContent = dangerous ? "2" : "1";
  }

  function updateTrendChart(reading) {
    state.history.push({ fill: reading.fill, gas: reading.gas, time: reading.timestamp });
    if (state.history.length > 12) state.history.shift();
    const pointsFor = (key) => state.history.map((item, index) => {
      const x = state.history.length === 1 ? 350 : index * 700 / (state.history.length - 1);
      const y = 185 - item[key] * 1.65;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const fillPoints = pointsFor("fill");
    const gasPoints = pointsFor("gas");
    $("fill-line").setAttribute("d", `M${fillPoints.join(" L")}`);
    $("gas-line").setAttribute("d", `M${gasPoints.join(" L")}`);
    $("fill-area").setAttribute("d", `M${fillPoints.join(" L")} L700,190 L0,190 Z`);
    $("x-labels").replaceChildren();
    const labelCount = Math.min(6, state.history.length);
    for (let index = 0; index < labelCount; index += 1) {
      const historyIndex = labelCount === 1 ? state.history.length - 1
        : Math.round(index * (state.history.length - 1) / (labelCount - 1));
      const time = state.history[historyIndex].time;
      const label = document.createElement("span");
      label.textContent = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(time);
      $("x-labels").append(label);
    }
  }

  function updateDashboard(reading) {
    state.lastReading = reading;
    updateTrendChart(reading);
    const dangerous = reading.fill >= thresholds.full || reading.gas >= thresholds.gasDanger;
    const warning = !dangerous && (reading.fill >= 65 || reading.gas >= thresholds.gasWarning);

    $("fill-value").textContent = Math.round(reading.fill);
    $("bin-level").style.width = `${reading.fill}%`;
    $("bin-level").className = `bin-level${dangerous && reading.fill >= thresholds.full ? " bad" : warning && reading.fill >= 65 ? " warn" : ""}`;
    setStatusPill($("fill-status"), reading.fill >= thresholds.full ? "PENUH" : reading.fill >= 65 ? "MENINGKAT" : "NORMAL",
      reading.fill >= thresholds.full ? "bad" : reading.fill >= 65 ? "warn" : "good");
    $("distance-label").textContent = reading.distance === null ? "• Jarak tidak tersedia" : `• Jarak ${reading.distance.toFixed(1)} cm`;

    $("gas-value").textContent = Math.round(reading.gas);
    $("gas-meter").style.width = `${reading.gas}%`;
    $("gas-meter").className = `meter-fill${reading.gas >= thresholds.gasDanger ? " bad" : reading.gas >= thresholds.gasWarning ? " warn" : ""}`;
    setStatusPill($("gas-status"), reading.gas >= thresholds.gasDanger ? "TINGGI" : reading.gas >= thresholds.gasWarning ? "WASPADA" : "NORMAL",
      reading.gas >= thresholds.gasDanger ? "bad" : reading.gas >= thresholds.gasWarning ? "warn" : "good");
    $("gas-source").textContent = `• ${reading.gasSource}`;

    $("temperature-value").textContent = reading.temperature === null ? "--" : reading.temperature.toFixed(1);
    $("humidity-value").textContent = reading.humidity === null ? "--" : Math.round(reading.humidity);
    $("humidity-wave").style.transform = `rotate(${-12 + (reading.humidity || 50) * 0.1}deg)`;
    $("temperature-note").textContent = reading.temperature === null ? "• Data tidak tersedia" : "• Kondisi saat ini";
    $("current-date").textContent = formatDate(new Date());
    $("alert-banner").className = `alert-banner${dangerous ? " danger" : warning ? " warning" : ""}`;
    $("alert-title").textContent = dangerous ? "Perlu tindakan segera" : warning ? "Kondisi perlu dipantau" : "Semua kondisi terkendali";
    $("alert-description").textContent = dangerous
      ? (reading.fill >= thresholds.full && reading.gas >= thresholds.gasDanger
        ? "Tempat sampah penuh dan indeks gas relatif tinggi."
        : reading.fill >= thresholds.full ? "Volume tempat sampah mencapai batas penuh."
          : "Indeks gas relatif melewati batas peringatan.")
      : warning ? "Volume sampah atau indeks gas mulai meningkat." : "Belum ada indikasi tempat sampah penuh atau gas tinggi.";
    $("alert-time").textContent = `Diperbarui ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(reading.timestamp)}`;
    updateSchedule(reading, dangerous);

    if (reading.latitude !== null && reading.longitude !== null) updateLocation(reading.latitude, reading.longitude, "sensor");
    if (dangerous && !state.previousAlert && !state.location) requestGps(true);
    state.previousAlert = dangerous;
  }

  function demoReading() {
    state.demoTick += 1;
    const wave = Math.sin(state.demoTick / 7);
    return {
      fill: 62 + wave * 5,
      distance: 38 - wave * 2,
      gas: 34 + Math.cos(state.demoTick / 5) * 5,
      gasSource: "Simulasi MQ-135 · relatif, bukan ppm",
      temperature: 29.4 + Math.sin(state.demoTick / 10) * 0.4,
      humidity: 68 + Math.cos(state.demoTick / 9) * 3,
      timestamp: new Date(),
      latitude: null,
      longitude: null
    };
  }

  async function pollApi(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Server sensor merespons HTTP ${response.status}.`);
    const reading = normalizeReading(await response.json());
    state.mode = "api";
    $("connection-label").textContent = "Terhubung ke perangkat";
    updateDashboard(reading);
  }

  async function connectApi(url) {
    if (!url) {
      toast("Masukkan URL endpoint API sensor terlebih dahulu.");
      return;
    }
    try {
      const parsedUrl = new URL(url, location.href);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Gunakan URL HTTP atau HTTPS.");
    } catch {
      toast("URL endpoint tidak valid.");
      return;
    }
    localStorage.setItem("wp2-api-url", url);
    $("api-url").value = url;
    clearInterval(state.interval);
    state.mode = "api";
    $("connection-label").textContent = "Menghubungkan…";
    try {
      await pollApi(url);
      state.interval = setInterval(async () => {
        try {
          await pollApi(url);
        } catch (error) {
          $("connection-label").textContent = "Koneksi terputus";
          $("alert-description").textContent = `Data terakhir ditampilkan. ${error.message}`;
        }
      }, 5000);
      toast("Sensor terhubung. Data diperbarui setiap 5 detik.");
    } catch (error) {
      state.mode = "demo";
      $("connection-label").textContent = "Koneksi gagal";
      state.interval = setInterval(() => updateDashboard(demoReading()), 8000);
      toast(`Gagal terhubung: ${error.message}`);
    }
  }

  function init() {
    $("current-date").textContent = formatDate(new Date());
    if (savedEndpoint || endpoint) $("api-url").value = endpoint || savedEndpoint;
    $("connect-button").addEventListener("click", () => $("connect-dialog").showModal());
    $("dialog-close").addEventListener("click", () => $("connect-dialog").close());
    $("connect-dialog").addEventListener("click", (event) => {
      if (event.target === $("connect-dialog")) $("connect-dialog").close();
    });
    $("connect-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const url = $("api-url").value.trim();
      await connectApi(url);
      if (state.mode === "api") $("connect-dialog").close();
    });
    $("demo-button").addEventListener("click", () => {
      localStorage.removeItem("ruangbersih-api-url");
      localStorage.removeItem("wp2-api-url");
      clearInterval(state.interval);
      state.mode = "demo";
      $("connection-label").textContent = "Mode demo";
      updateDashboard(demoReading());
      state.interval = setInterval(() => updateDashboard(demoReading()), 8000);
      $("connect-dialog").close();
      toast("Mode demo diaktifkan.");
    });
    $("refresh-button").addEventListener("click", async () => {
      if (state.mode === "api" && (endpoint || savedEndpoint)) {
        try { await pollApi(endpoint || savedEndpoint); }
        catch (error) { toast(`Gagal memperbarui: ${error.message}`); }
      } else {
        updateDashboard(demoReading());
        toast("Data demo diperbarui.");
      }
    });
    $("gps-button").addEventListener("click", () => requestGps(false));
    document.querySelectorAll(".navigation a").forEach((link) => {
      link.addEventListener("click", () => {
        document.querySelectorAll(".navigation a").forEach((item) => item.classList.remove("active"));
        link.classList.add("active");
      });
    });
    updateDashboard(demoReading());
    if (endpoint || savedEndpoint) {
      connectApi(endpoint || savedEndpoint);
    } else {
      state.interval = setInterval(() => updateDashboard(demoReading()), 8000);
    }
  }

  init();
})();