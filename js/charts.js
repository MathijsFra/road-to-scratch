// Grafieken met Chart.js (globaal beschikbaar via CDN).

let hcpChart = null;
let stbChart = null;
let trendChart = null;

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
