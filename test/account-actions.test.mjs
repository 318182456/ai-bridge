import test from 'node:test';import assert from 'node:assert/strict';
import {createAccountActions,accountBackendStates} from '../public/js/components/account-actions.mjs';
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.className='';this.isConnected=true;this.classList={add:(name)=>{this.className+=' '+name;}};}
 append(...items){for(const item of items){if(item.parent){item.parent.children=item.parent.children.filter(n=>n!==item);}item.parent=this;this.children.push(item);}}
 setAttribute(name,value){this.attrs[name]=value;}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
function dom(){const before=globalThis.document;globalThis.document={createElement:t=>new Element(t)};return()=>{globalThis.document=before;};}
const account={id:'g_synthetic',name:'<img src=x onerror=alert(1)>',google:{enabled:true,grants:{aist:'verified',robin:'authenticated'},backend_enabled:{aist:true,robin:false},verification:{aist:{state:'failed',message:'Synthetic upstream error'}}}};
test('row keeps only two entries; backend actions and deletions stay in their own nearby groups without executing them',async()=>{
 const restore=dom();let invoked=0,opened=0,closed=0;try{const actions=createAccountActions({account,onOpen:()=>opened++,onError:()=>assert.fail('unexpected error')});
 for(const backend of ['aist','robin','agy']){actions.add('Login',()=>invoked++,{backend,kind:'login'});actions.add('Delete '+backend,()=>invoked++,{backend,danger:true});}actions.add('Rename',()=>invoked++);actions.add('Remove record',()=>invoked++,{danger:true});
 const {bar,manage}=actions.row();assert.equal(bar.children.length,2);assert.equal(bar.children[0].textContent,'管理后端');assert.equal(bar.children[1].children[0].textContent,'账号操作');assert.equal(invoked,0);assert.equal(descendants(bar).filter(n=>n.tagName==='button').length,3);manage.onclick();assert.equal(opened,1);
 const panel=actions.panel(accountBackendStates(account),()=>closed++),cards=descendants(panel).filter(n=>n.tagName==='section');assert.equal(cards.length,3);for(const [i,id]of ['aist','robin','agy'].entries()){const deletion=descendants(cards[i]).find(n=>n.textContent==='Delete '+id);assert.equal(deletion.parent.tagName,'details');assert.equal(deletion.parent.children[0].textContent,'删除授权');assert.equal(descendants(cards[i]).filter(n=>n.tagName==='button').length,2);}
 const close=descendants(panel).find(n=>n.textContent==='收起');close.onclick();assert.equal(closed,1);assert.equal(invoked,0);assert.equal(descendants(panel).some(n=>'innerHTML' in n),false);
 }finally{restore();}
});
test('repeated activation does not replay mutations, failures stay with the owning account and locked controls remain disabled',async()=>{
 const restore=dom();try{let done,calls=0,errors=0;const actions=createAccountActions({account,onOpen(){},onError:()=>errors++});const button=actions.add('Toggle',()=>{calls++;return new Promise(r=>done=r);},{backend:'aist'});const first=button.onclick();await button.onclick();assert.equal(calls,1);assert.equal(button.disabled,true);done();await first;assert.equal(button.disabled,false);
 const failed=actions.add('Failure',async()=>{throw Error('synthetic');});await failed.onclick();assert.equal(errors,1);assert.equal(failed.disabled,false);const locked=createAccountActions({account,locked:true,onOpen(){},onError(){}});assert.equal(locked.add('Delete',()=>{},{backend:'robin',danger:true}).disabled,true);assert.equal(locked.add('Google login',()=>{},{backend:'aist',kind:'login'}).disabled,true);assert.equal(locked.add('Resume login',()=>{},{backend:'agy',kind:'login'}).disabled,false);
 }finally{restore();}
});
test('short status preserves disabled/error semantics and native-only rows have no invented Google controls',()=>{
 const restore=dom();try{const status=accountBackendStates(account);assert.equal(status.aist.label,'校验失败');assert.equal(status.aist.error,'Synthetic upstream error');assert.equal(status.robin.label,'已停用');assert.equal(status.robin.error,null);assert.equal(status.agy.label,'未关联');
 const native={id:'a_synthetic',name:'Native',native:{status:'ready',enabled:false}};const actions=createAccountActions({account:native,onOpen(){},onError(){}});actions.add('Login',()=>{},{backend:'agy',kind:'login'});const panel=actions.panel(accountBackendStates(native),()=>{});assert.equal(descendants(panel).filter(n=>n.tagName==='section').length,1);assert.equal(accountBackendStates(native).agy.label,'已停用');
 }finally{restore();}
});
