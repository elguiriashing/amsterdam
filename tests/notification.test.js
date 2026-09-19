import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prefillNotification} from '../registration-notification.js';
test('Telegram notification restores heading and panel link and adds saved total',()=>{
 const text=prefillNotification({fullname:'PRIVATE',email:'PRIVATE',phone:'PRIVATE'},42);
 assert.match(text,/<b>New Web Membership Prefill!<\/b>/);assert.match(text,/<b>Total saved pre-fills:<\/b> 42/);assert.match(text,/https:\/\/socialclubamsterdam.com\/registration-desk/);assert.ok(!text.includes('PRIVATE'));
});
