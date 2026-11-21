import pngjs from "pngjs";
import {AppError} from "../common.mjs";
const invalid=()=>new AppError(503,"完整浏览器画面格式无效","desktop_frame_invalid");
// ASVS V2.2: validate binary dimensions/length before allocation or pixel access.
export function xwdPng(bytes,{width,height}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>16*1024*1024)throw invalid();const word=i=>bytes.readUInt32BE(i*4),header=word(0),w=word(4),h=word(5),order=word(7),bits=word(11),stride=word(12),colors=word(19),start=header+colors*12;
 if(word(1)!==7||word(2)!==2||header<100||header>65536||!w||!h||w>1920||h>1200||![24,32].includes(bits)||![0,1].includes(order)||colors>65536||stride<w*bits/8||stride>w*bits/8+65536||start+stride*h>bytes.length||word(14)!==0xff0000||word(15)!==0xff00||word(16)!==0xff)throw invalid();
 const cw=Math.min(w,width||w),ch=Math.min(h,height||h);if(!Number.isInteger(cw)||!Number.isInteger(ch)||cw<1||ch<1)throw invalid();const image=new pngjs.PNG({width:cw,height:ch}),bpp=bits/8;
 for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const at=start+y*stride+x*bpp,out=(y*cw+x)*4;image.data[out]=bytes[at+(order?bpp-3:2)];image.data[out+1]=bytes[at+(order?bpp-2:1)];image.data[out+2]=bytes[at+(order?bpp-1:0)];image.data[out+3]=255;}
 return{bytes:pngjs.PNG.sync.write(image,{filterType:4,deflateLevel:3}),width:cw,height:ch};
}
