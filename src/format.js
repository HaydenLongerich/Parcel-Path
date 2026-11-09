const parseDay = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
};

export function formatDay(iso, options = { month: 'short', day: 'numeric' }) {
  const day = parseDay(iso);
  return day ? day.toLocaleDateString('en-CA', options) : iso;
}

export const formatLongDay = (iso) =>
  formatDay(iso, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export function formatTime(time) {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}

export const formatMoney = (amount) => amount.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });

export const formatClock = (timestamp) =>
  new Date(timestamp).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
