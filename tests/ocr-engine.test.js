import test from 'node:test';
import sharp from 'sharp';import {scanIdentity} from '../registration-ocr.js';import assert from 'node:assert/strict';
test('real OCR reads a sideways synthetic passport image',{timeout:90000},async()=>{
const lines=['P<UTOERIKSSON<<ANNA<MARIA'.padEnd(44,'<'),'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
const svg='<svg width="1900" height="350">'+ '<rect width="100%" height="100%" fill="white"/>'+lines.map((l,i)=>`<text x="40" y="${120+i*90}" font-family="monospace" font-size="60">${l.replaceAll('<','&lt;')}</text>`).join('')+'</svg>';
const image=await sharp(Buffer.from(svg)).png().rotate(90).toBuffer();const r=await scanIdentity(image);assert.equal(r.suggestions.documentNumber,'L898902C3');
});
