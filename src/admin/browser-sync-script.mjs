import {readFile} from 'node:fs/promises';
export async function browserSyncScript(origin){const url=new URL(origin);const pattern=url.protocol+'//'+url.hostname+'/panel/*';return `// ==UserScript==
// @name AI Bridge 本机登录同步
// @namespace ${origin}/
// @version 0.1.1
// @description 在本机 Google 页面手动登录后，同步至你自己的 AI Bridge；不含第三方接收服务。
// @match ${pattern}
// @match https://aistudio.google.com/*
// @match https://accounts.google.com/*
// @match https://alkalimakersuite-pa.clients6.google.com/*
// @connect ${url.hostname}
// @grant unsafeWindow
// @grant GM_cookie
// @grant GM_xmlhttpRequest
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_deleteValue
// @grant GM_registerMenuCommand
// @run-at document-idle
// @noframes
// @updateURL ${origin}/userscripts/ai-bridge.user.js
// @downloadURL ${origin}/userscripts/ai-bridge.user.js
// ==/UserScript==
`+(await readFile(new URL('../../public/userscripts/browser-sync.template.js',import.meta.url),'utf8')).replace('__BRIDGE_ORIGIN__',JSON.stringify(origin));}
