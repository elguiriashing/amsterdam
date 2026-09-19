import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prefillNotification} from '../registration-notification.js';
test('Telegram includes approved contact fields, safely escapes markup and uses Spain time',()=>{
 const text=prefillNotification({fullname:'A & <B>',email:'test@example.com',phone:'+34600000000',ts:'2026-09-18T20:28:10Z',dob:'1990-01-01',documentNumber:'PRIVATE',address:{line:'PRIVATE'}},42);
 assert.match(text,/<b>Name:<\/b> A &amp; &lt;B&gt;/);assert.match(text,/<b>Email:<\/b> test@example.com/);assert.match(text,/<b>Phone:<\/b> \+34600000000/);assert.match(text,/22:28:10/);assert.match(text,/<b>Total saved pre-fills:<\/b> 42/);assert.ok(!text.includes('PRIVATE'));assert.ok(!text.includes('1990-01-01'));
});
