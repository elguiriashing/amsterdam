const html=value=>String(value??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export function prefillNotification(prefill,total){
 const received=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',dateStyle:'short',timeStyle:'medium'}).format(new Date(prefill.ts));
 return `📩<b>New Web Membership Prefill!</b>📩\n\n<b>Name:</b> ${html(prefill.fullname||[prefill.firstName,prefill.surname].filter(Boolean).join(' '))}\n<b>Email:</b> ${html(prefill.email||'—')}\n<b>Phone:</b> ${html(prefill.phone)}\n<b>Received:</b> ${received} (Spain)\n\n📊 <b>Total saved pre-fills:</b> ${total}\n\n📱<b>Check it out in the panel</b>📱\nhttps://socialclubamsterdam.com/registration-desk`;
}
