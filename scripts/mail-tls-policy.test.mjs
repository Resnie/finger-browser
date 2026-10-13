import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMailTlsOptions } from '../electron/utils/mailTlsPolicy.mjs';
test('configured Mailcow exception is explicit and restricted to its TLS host',()=>{
 assert.deepEqual(resolveMailTlsOptions({host:'mail.outlook.top',verifyCertificate:false}),{rejectUnauthorized:false});
 assert.deepEqual(resolveMailTlsOptions({host:'mail.outlook.top'}),{rejectUnauthorized:true});
 assert.deepEqual(resolveMailTlsOptions({host:'imap.gmail.com'}),{rejectUnauthorized:true});
 assert.throws(()=>resolveMailTlsOptions({host:'imap.gmail.com',verifyCertificate:false}));
 assert.throws(()=>resolveMailTlsOptions({host:'mail.outlook.top.evil.invalid',verifyCertificate:false}));
 assert.throws(()=>resolveMailTlsOptions({host:'mail.outlook.top',verifyCertificate:'false'}));
});
