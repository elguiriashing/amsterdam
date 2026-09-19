import crypto from 'node:crypto';
export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export function text(value, max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function adult(dob, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return false;
  const d = new Date(dob + 'T12:00:00Z');
  if (!Number.isFinite(+d) || d.toISOString().slice(0,10) !== dob) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
  const [y,m,day] = today.split('-').map(Number);
  const cutoff = `${y-18}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  return dob <= cutoff && dob >= `${y-120}-01-01`;
}
export function details(body) {
  const d = { firstName:text(body.firstName,80), surname:text(body.surname,120), dob:text(body.dob,10), email:text(body.email,254).toLowerCase(), phone:text(body.phone,30), address:{ line:text(body.address?.line), city:text(body.address?.city,100), postcode:text(body.address?.postcode,5), country:'ES' }, documentNumber:text(body.documentNumber,40).toUpperCase() };
  if (d.documentNumber && !/^[A-Z0-9][A-Z0-9 .-]{2,39}$/.test(d.documentNumber)) throw new InputError('Enter a valid ID or passport number.');
  if (!d.firstName || !d.surname) throw new InputError('Enter name and surname.');
  if (!adult(d.dob)) throw new InputError('Enter a valid date of birth. Applicants must be 18 or older.');
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw new InputError('Enter a valid email address.');
  if (!/^[+\d ()-]{7,30}$/.test(d.phone) || d.phone.replace(/\D/g,'').length < 7) throw new InputError('Enter a valid phone number including country code.');
  if (body.address?.country !== 'ES' || !d.address.line || !d.address.city || !/^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(d.address.postcode)) throw new InputError('Enter the street or accommodation, town and valid Spanish postcode.');
  return {...d, fullname:`${d.firstName} ${d.surname}`};
}
export function numberValue(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > 999999999) throw new InputError('Use a whole member number from 1 to 999999999.'); return n; }
export function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function identityKey(value) { return value ? crypto.createHmac('sha256',process.env.ID_HASH_SECRET || process.env.JWT_SECRET).update(value.replace(/[^A-Z0-9]/g,'')).digest('hex') : null; }
export function ocrSuggestions(raw) {
  const lines=raw.toUpperCase().split('\n').map(x=>x.replace(/\s/g,''));
  const line=lines.find(x=>/^P[A-Z<][A-Z<]{3}/.test(x) && x.includes('<<'));
  const out={};
  if(line) { const [surname,first]=line.slice(5).split('<<');out.surname=surname.replace(/</g,' ').trim();out.firstName=(first||'').replace(/</g,' ').trim(); }
  const mrz=lines.find(x=>/^[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d[MF<]/.test(x));
  if(mrz) { out.documentNumber=mrz.slice(0,9).replace(/</g,''); const date=mrz.slice(13,19); const yy=+date.slice(0,2); const year=yy>(new Date().getFullYear()%100)?1900+yy:2000+yy;out.dob=`${year}-${date.slice(2,4)}-${date.slice(4,6)}`; }
  return out;
}
