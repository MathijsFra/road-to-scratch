// Grafieken met Chart.js (globaal beschikbaar via CDN).

let hcpChart = null;
let stbChart = null;
let trendChart = null;
let scoreBreakdownChart = null;
let radarChart = null;
let multiStatChart = null;

function linearRegressionLine(values) {
  const pts = values.map((y, i) => ({ x: i, y })).filter((p) => p.y !== null);
  if (pts.length < 3) return values.map(() => null);
  const n = pts.length;
  const sumX = pts.reduce((a, p) => a + p.x, 0);
  const sumY = pts.reduce((a, p) => a + p.y, 0);
  const sumXY = pts.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = pts.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (!denom) return values.map(() => null);
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const first = pts[0].x;
  const last = pts[pts.length - 1].x;
  return values.map((_, i) =>
    i >= first && i <= last ? Math.round((slope * i + intercept) * 10) / 10 : null,
  );
}

const GREEN = "#16a34a";
const GREEN_DARK = "#14532d";
const GOLD = "#d97706";
const PURPLE = "#8b5cf6";
const GRID = "rgba(15,27,18,0.08)";

function fmtLabel(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}`;
}

function baseOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { padding: 10, cornerRadius: 8 },
    },
    scales: {
      x: { grid: { color: GRID }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkipPadding: 8 } },
      y: { grid: { color: GRID }, ticks: { font: { size: 10 } } },
    },
  };
}

// ---------- Benchmark curves ----------
const GIR_CURVE = [[0,65],[5,50],[10,37],[15,26],[20,22],[25,19],[30,12],[36,6],[54,3]];
const FW_CURVE  = [[0,57],[5,51],[10,49],[15,48],[20,43],[25,43],[30,38],[36,30],[54,22]];
const TP_CURVE  = [[0,1.5],[5,2.0],[10,2.5],[15,3.5],[20,4.2],[25,5.8],[30,7.0],[36,8.5],[54,12.0]];
const PEN_CURVE = [[0,0.5],[5,0.8],[10,1.5],[15,2.0],[20,2.8],[25,3.5],[30,5.0],[36,6.5],[54,10.0]];
const DB_CURVE  = [[0,1.5],[5,5],[10,14],[15,26],[20,37],[25,51],[30,60],[36,67],[54,75]];

function lerpCurve(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  if (x >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    if (x >= curve[i][0] && x <= curve[i + 1][0]) {
      const t = (x - curve[i][0]) / (curve[i + 1][0] - curve[i][0]);
      return curve[i][1] + t * (curve[i + 1][1] - curve[i][1]);
    }
  }
  return curve[curve.length - 1][1];
}

// Normalize stat to 0–100 (higher = better performance relative to scratch range)
function normScore(val, best, worst, higherBetter = true) {
  if (val == null) return null;
  const range = Math.abs(best - worst);
  if (!range) return 50;
  const score = higherBetter
    ? (val - worst) / range * 100
    : (worst - val) / range * 100;
  return Math.max(0, Math.min(100, score));
}

// Score breakdown per round: last 15 qualifying rounds with holes_data
function _roundBreakdown(rounds) {
  const qualifying = rounds
    .filter(r => !r.non_qualifying && !r.deleted_at && Array.isArray(r.holes_data) && r.holes_data.length >= 9)
    .slice(-15);
  const labels = [], birdies = [], pars = [], bogeys = [], doubles = [], triples = [];
  for (const r of qualifying) {
    let b = 0, pa = 0, bo = 0, db = 0, tr = 0;
    for (const h of r.holes_data) {
      if (h.score == null || h.par == null) { pa++; continue; }
      const diff = Number(h.score) - Number(h.par);
      if (diff <= -1) b++;
      else if (diff === 0) pa++;
      else if (diff === 1) bo++;
      else if (diff === 2) db++;
      else tr++;
    }
    labels.push(fmtLabel(r.date));
    birdies.push(b); pars.push(pa); bogeys.push(bo); doubles.push(db); triples.push(tr);
  }
  return { labels, birdies, pars, bogeys, doubles, triples };
}

// GIR% / FW% / scrambling% per qualifying round (last 20 with data)
function _perRoundStats(rounds) {
  return rounds
    .filter(r => !r.non_qualifying && !r.deleted_at && (r.gir != null || r.fairways_hit != null))
    .slice(-20)
    .map(r => {
      const holes = r.holes || 18;
      const girPct = r.gir != null ? Math.round(r.gir / holes * 100) : null;
      const fwPct = (r.fairways_hit != null && r.fairways_total)
        ? Math.round(r.fairways_hit / r.fairways_total * 100) : null;
      let scrambling = null;
      if (Array.isArray(r.holes_data) && r.holes_data.length) {
        let missed = 0, saved = 0;
        for (const h of r.holes_data) {
          if (h.gir === false) {
            missed++;
            if (h.score != null && h.par != null && Number(h.score) <= Number(h.par)) saved++;
          }
        }
        if (missed >= 3) scrambling = Math.round(saved / missed * 100);
      }
      return { date: r.date, girPct, fwPct, scrambling };
    });
}

// ---------- Bestaande grafieken ----------

export function renderHcpChart(rounds) {
  const el = document.getElementById("hcpChart");
  if (!el || typeof Chart === "undefined") return;

  const labels = rounds.map((r) => fmtLabel(r.date));
  const hcp = rounds.map((r) => (r.hcp != null ? Number(r.hcp) : null));
  const sd = rounds.map((r) => (r.sd != null ? Number(r.sd) : null));
  const trendLine = linearRegressionLine(hcp);

  if (hcpChart) hcpChart.destroy();
  hcpChart = new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Handicap",
          data: hcp,
          borderColor: GREEN_DARK,
          backgroundColor: "rgba(20,83,45,0.08)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: GREEN_DARK,
          spanGaps: true,
        },
        {
          label: "Trendlijn",
          data: trendLine,
          borderColor: "rgba(22,163,74,0.55)",
          borderWidth: 2,
          borderDash: [6, 4],
          fill: false,
          tension: 0,
          pointRadius: 0,
          spanGaps: false,
        },
        {
          label: "Dagresultaat (SD)",
          data: sd,
          borderColor: GOLD,
          borderWidth: 1.5,
          borderDash: [5, 4],
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: GOLD,
          spanGaps: true,
        },
      ],
    },
    options: baseOpts(),
  });
}

export function renderStbChart(rounds) {
  const el = document.getElementById("stbChart");
  if (!el || typeof Chart === "undefined") return;

  const labels = rounds.map((r) => fmtLabel(r.date));
  const stb = rounds.map((r) => (r.stb != null ? Number(r.stb) : null));
  const colors = rounds.map((r) => (r.holes === 18 ? GREEN_DARK : GREEN));

  if (stbChart) stbChart.destroy();
  stbChart = new Chart(el, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Stableford (donker = 18h, licht = 9h)",
          data: stb,
          backgroundColor: colors,
          borderRadius: 6,
          maxBarThickness: 34,
        },
      ],
    },
    options: baseOpts(),
  });
}

export function renderTrendChart(trend) {
  const el = document.getElementById("trendChart");
  if (!el || typeof Chart === "undefined") return;

  const labels = trend.map((p) => fmtLabel(p.date));
  const avg = trend.map((p) => p.avg);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "10-rondes gemiddelde dagresultaat (SD)",
          data: avg,
          borderColor: GREEN,
          backgroundColor: "rgba(22,163,74,0.12)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: GREEN,
          spanGaps: true,
        },
      ],
    },
    options: baseOpts(),
  });
}

// ---------- Nieuwe grafieken ----------

export function renderScoreBreakdownChart(rounds) {
  const el = document.getElementById("scoreBreakdownChart");
  const emptyEl = document.getElementById("scoreBreakdownEmpty");
  if (!el || typeof Chart === "undefined") return;

  const data = _roundBreakdown(rounds);
  if (!data.labels.length) {
    if (scoreBreakdownChart) { scoreBreakdownChart.destroy(); scoreBreakdownChart = null; }
    el.hidden = true;
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  el.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  if (scoreBreakdownChart) scoreBreakdownChart.destroy();

  const opts = baseOpts();
  opts.scales.x.stacked = true;
  opts.scales.y.stacked = true;
  opts.scales.y.ticks = { ...opts.scales.y.ticks, stepSize: 1 };

  scoreBreakdownChart = new Chart(el, {
    type: "bar",
    data: {
      labels: data.labels,
      datasets: [
        { label: "Birdie of beter", data: data.birdies, backgroundColor: "#16a34a", borderRadius: 3, maxBarThickness: 30 },
        { label: "Par",             data: data.pars,    backgroundColor: "#6b7c70", borderRadius: 0, maxBarThickness: 30 },
        { label: "Bogey",           data: data.bogeys,  backgroundColor: "#d97706", borderRadius: 0, maxBarThickness: 30 },
        { label: "Double bogey",    data: data.doubles, backgroundColor: "#dc2626", borderRadius: 0, maxBarThickness: 30 },
        { label: "Triple of erger", data: data.triples, backgroundColor: "#7f1d1d", borderRadius: 3, maxBarThickness: 30 },
      ],
    },
    options: opts,
  });
}

export function renderRadarChart(stats) {
  const el = document.getElementById("radarChart");
  const emptyEl = document.getElementById("radarEmpty");
  if (!el || typeof Chart === "undefined") return;

  const p = stats.play;
  const hasData = p.girPct != null || p.fairwayPct != null || p.threePutts != null;
  if (!hasData) {
    if (radarChart) { radarChart.destroy(); radarChart = null; }
    el.hidden = true;
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  el.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  const hcp = Math.max(0, stats.currentHcp ?? 36);

  const benchGir = lerpCurve(GIR_CURVE, hcp);
  const benchFw  = lerpCurve(FW_CURVE,  hcp);
  const benchTp  = lerpCurve(TP_CURVE,  hcp);
  const benchPen = lerpCurve(PEN_CURVE, hcp);
  const benchDb  = lerpCurve(DB_CURVE,  hcp);

  const playerData = [
    normScore(p.girPct,          65,  3,   true),
    normScore(p.fairwayPct,      57,  22,  true),
    normScore(p.threePutts,      1.5, 12,  false),
    normScore(p.penalties,       0.5, 10,  false),
    normScore(p.doubleBogeyRate, 1.5, 75,  false),
  ];
  const benchData = [
    normScore(benchGir,  65,  3,   true),
    normScore(benchFw,   57,  22,  true),
    normScore(benchTp,   1.5, 12,  false),
    normScore(benchPen,  0.5, 10,  false),
    normScore(benchDb,   1.5, 75,  false),
  ];

  if (radarChart) radarChart.destroy();
  radarChart = new Chart(el, {
    type: "radar",
    data: {
      labels: ["GIR%", "Fairway%", "3-putts", "Penalties", "Double bogeys"],
      datasets: [
        {
          label: "Jij",
          data: playerData,
          borderColor: GREEN,
          backgroundColor: "rgba(22,163,74,0.18)",
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: GREEN,
        },
        {
          label: `Doel HCP ${Math.round(hcp)}`,
          data: benchData,
          borderColor: GOLD,
          backgroundColor: "rgba(217,119,6,0.08)",
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 3,
          pointBackgroundColor: GOLD,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          padding: 10,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.raw ?? 0)}%`,
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, font: { size: 9 }, display: false },
          grid: { color: GRID },
          angleLines: { color: GRID },
          pointLabels: { font: { size: 11 } },
        },
      },
    },
  });
}

export function renderMultiStatTrendChart(rounds, active = { gir: true, fw: true, scrambling: true }) {
  const el = document.getElementById("multiStatChart");
  const emptyEl = document.getElementById("multiStatEmpty");
  if (!el || typeof Chart === "undefined") return;

  const perRound = _perRoundStats(rounds);
  if (!perRound.length) {
    if (multiStatChart) { multiStatChart.destroy(); multiStatChart = null; }
    el.hidden = true;
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  el.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  const labels = perRound.map(r => fmtLabel(r.date));
  const datasets = [];

  if (active.gir !== false) {
    datasets.push({
      label: "GIR%",
      data: perRound.map(r => r.girPct),
      borderColor: GREEN,
      borderWidth: 2.5,
      fill: false,
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: GREEN,
      spanGaps: true,
    });
  }
  if (active.fw !== false) {
    datasets.push({
      label: "Fairway%",
      data: perRound.map(r => r.fwPct),
      borderColor: GOLD,
      borderWidth: 2.5,
      fill: false,
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: GOLD,
      spanGaps: true,
    });
  }
  if (active.scrambling !== false) {
    datasets.push({
      label: "Scrambling%",
      data: perRound.map(r => r.scrambling),
      borderColor: PURPLE,
      borderWidth: 2.5,
      fill: false,
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: PURPLE,
      spanGaps: true,
    });
  }

  if (multiStatChart) multiStatChart.destroy();
  if (!datasets.length) { multiStatChart = null; return; }

  const opts = baseOpts();
  opts.scales.y.min = 0;
  opts.scales.y.max = 100;
  opts.scales.y.ticks = { ...opts.scales.y.ticks, callback: (v) => v + "%" };

  multiStatChart = new Chart(el, {
    type: "line",
    data: { labels, datasets },
    options: opts,
  });
}
