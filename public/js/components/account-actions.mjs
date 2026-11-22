import {el} from '../core.mjs';
const backendNames={aist:'AI Studio',robin:'Robin',agy:'Antigravity CLI'};
// ASVS 1.2.1: account names and upstream messages are text, never HTML.
export function createAccountActions({account,onOpen,onError,locked=false}){
 const groups=new Map(['aist','robin','agy','account'].map(id=>[id,[]]));
 function add(label,run,{backend='account',kind='secondary',danger=false}={}){
  const button=el('button',label,'secondary small'+(danger?' danger':''));button.type='button';button.disabled=locked&&!(backend==='agy'&&kind==='login');
  button.onclick=async()=>{if(button.disabled)return;button.disabled=true;try{await run();}catch(error){onError(error);}finally{if(button.isConnected)button.disabled=locked&&!(backend==='agy'&&kind==='login');}};
  groups.get(backend).push({button,kind,danger});return button;
 }
 function row(){
  const bar=el('div','','account-action-bar'),manage=el('button','管理后端','secondary small');manage.type='button';manage.setAttribute('aria-expanded','false');manage.setAttribute('aria-controls','detail-'+account.id);manage.onclick=onOpen;bar.append(manage);
  const menu=el('details','','account-record-actions'),summary=el('summary','账号操作');menu.append(summary);summary.setAttribute('aria-label',account.name+' 的账号操作');
  const list=el('div','','account-record-action-list');for(const action of groups.get('account'))list.append(action.button);menu.append(list);bar.append(menu);return{bar,manage};
 }
 function panel(statuses,onClose){
  const cell=el('td','','detail-cell account-management-cell');cell.colSpan=8;
  const heading=el('div','','backend-manager-heading'),intro=el('div'),close=el('button','收起','secondary small');intro.append(el('strong','后端管理'),el('p','登录与启停在对应后端内操作；账号名称和记录在“账号操作”中管理。','muted'));close.type='button';close.onclick=onClose;heading.append(intro,close);
  const grid=el('div','','backend-manager-grid');
  for(const id of ['aist','robin','agy']){
   const actions=groups.get(id);if(!actions.length)continue;
   const state=statuses[id],card=el('section','','backend-account-card'),head=el('div','','backend-card-heading');card.setAttribute('aria-label',backendNames[id]+' 管理');
   head.append(el('h3',backendNames[id]),el('span',state.label,'backend-state '+state.tone));card.append(head);
   card.append(el('p',id==='agy'?'官方 CLI 独立登录，可查询账号额度。':'本机浏览器登录，同步此后端的凭据。','backend-card-caption'));
   const controls=el('div','','backend-card-controls');for(const action of actions.filter(a=>!a.danger)){if(action.kind==='login')action.button.classList.add('backend-login-action');controls.append(action.button);}card.append(controls);
   if(state.error){const details=el('details','','backend-error-details');details.append(el('summary','查看错误详情'),el('p',state.error,'status-error'));card.append(details);}
   const dangerous=actions.filter(a=>a.danger);if(dangerous.length){const danger=el('details','','backend-danger-actions');danger.append(el('summary','删除授权'));danger.append(el('small','移除登录资料；账号与历史用量保留。'));for(const action of dangerous)danger.append(action.button);card.append(danger);}
   grid.append(card);
  }
  const scroll=el('div','','backend-manager-scroll');scroll.append(grid);cell.append(heading,scroll);return cell;
 }
 return{add,row,panel};
}
export function accountBackendStates(account){
 const result={};
 const native=account.native;
 result.agy=!native?{label:'未关联',tone:'muted'}:{label:({not_logged_in:'未登录',ready:native.enabled?'已启用':'已停用',account_suspended:'账号已停用',login_required:'需重新登录',generation_unverified:'待校验'})[native.status]||'待处理',tone:native.enabled&&native.status==='ready'?'status-ready':'muted'};
 for(const id of ['aist','robin']){const g=account.google,grant=g?.grants?.[id]||'not_authorized',enabled=g?.backend_enabled?.[id]??g?.enabled,error=g?.verification?.[id]?.state==='failed'?g.verification[id].message:null;
  result[id]={label:grant==='not_authorized'?'未登录':!enabled?'已停用':error?'校验失败':({verified:'已启用',synced:'已同步 · 待校验',authenticated:'已授权 · 待校验',needs_attention:'需处理'})[grant]||'需处理',tone:enabled&&error?'status-error':enabled&&grant==='verified'?'status-ready':'muted',error:enabled?error:null};
 }
 return result;
}
