/*************************************************************************************************
 * EWS BILLING — WEB APP BACKEND  (Google Apps Script)
 * Database for the REVO Billing Platform (index.html).
 *
 *  ALL data now lives in ONE master workbook: "EWS Billing Tracker" (BOOK_ID below).
 *    - Tracker rows  : tabs  "Billing Tracker"  (current) + "Prior Years (2022-2025)"  (history)
 *    - Rate cards    : tabs  "Billing Schedule 755" / "Billing Schedule 765"
 *    - Contacts      : tab   "Fleet Directory"
 *  Columns are detected BY HEADER NAME (robust to column moves). Paid = a "Paid" column OR
 *  Invoice Status = "Paid". Unit is read from "Billing Unit" text (…(765)/(755)) or the invoice prefix.
 *
 * ENDPOINTS
 *   GET  ?action=summary    → all tracker rows as JSON
 *   GET  ?action=schedule   → 755 / 765 rate cards
 *   GET  ?action=directory  → Fleet Directory
 *   GET  ?action=inspect    → detected header→column map + sample rows for each tracker tab (verification)
 *   POST {action:"po"|"invoice"|"update", payload}   → append / update the Billing Tracker tab
 *
 * DEPLOY:  Apps Script with access to the master workbook → Deploy → Web app → Execute as Me →
 *          Access Anyone → copy /exec into index.html CONFIG.EXEC_URL. Re-version on every edit.
 *************************************************************************************************/

var BOOK_ID  = '1dSmx19Gt14cJMYZdO-CDo41sM7KaFSYdbmq2pN3jJhA';   // master "EWS Billing Tracker" workbook
var TRK_TABS = ['Billing Tracker', 'Prior Years (2022-2025)'];   // read these for tracker rows
var WRITE_TAB= 'Billing Tracker';                                // new PO/invoice rows + edits go here
var SCH_755  = 'Billing Schedule 755', SCH_765 = 'Billing Schedule 765', DIRECTORY = 'Fleet Directory';
var LISTS_TAB= 'Lists';                                          // dropdown source: A=Operators, B=Category(Disc)
var LOG_TAB  = 'Access Log';                                     // sign-in audit log: Timestamp | Email | Name | Browser
var EMAIL_TAB= 'Email Lists';                                    // CC recipients per doc type: A=PO Request, B=Invoice, C=Reminder, D=Collections
var DRIVE_ROOT = '1U3dQyP_Il3aQzAcmBr5NyNzPVLmprqGJ';           // cfacchine-owned "EWS Billing" folder (sections: Invoice Request / PO Assigned / Invoice Signed / PO Requests). Was 1uMR9dqS52Z4ZqUAqmIaLzUqLhpmmtAZY (personal-account folder).

/* Inbox auto-file (#1): scans Gmail for customer replies with a PDF, files it to your Drive by year
   (approved PO → "PO Assigned"/Year, signed invoice → "Invoice Signed"/Year), links it on the tracker
   row and flags it for a one-click confirm. It NEVER flips PO/Signed on its own. Preview-safe. */
var INBOX = {
  POASSIGNED_FOLDER: 'PO Assigned',       // approved customer-PO PDFs land here (under EWS Billing / <folder> / <year>)
  SIGNED_FOLDER:     'Invoice Signed',    // signed-invoice PDFs land here
  LOG_TAB: 'Inbox Log',                   // processed Gmail message ids (dedupe)
  LOOKBACK_DAYS: 30,                      // scan replies received in the last N days
  HOUR: 6                                 // daily trigger hour if you install it
};

/* Email CC lists — one "Email Lists" tab controls who is CC'd on each document type. These defaults seed
   the tab the first time the app reads it (or Run ▸ seedEmailLists); after that the sheet is the source
   of truth. The "To" is always the fleet contact from the Fleet Directory tab. */
var DEFAULT_NOTIFY_CC = ['cfacchine@revolution-es.com','fwright@revolution-es.com','gkail@revolution-es.com','jkinder@revolution-es.com','mpuskarich@revolution-es.com','rmcclain@revolution-es.com','accountexecutive@mcf.fund','servicerequest@beusaenergy.com','jason.jacobs@beusaenergy.com','nicholas.kelley@evolutionws.com','ben.sweeney@evolutionws.com','Dchero@beusaenergy.com','radams@beusaenergy.com'];   // PO Request · Invoice · Reminder
var DEFAULT_AR_CC     = ['fwright@revolution-es.com','jkinder@revolution-es.com','mpuskarich@revolution-es.com','jason.jacobs@beusaenergy.com','servicerequest@beusaenergy.com','gkail@revolution-es.com','accountexecutive@mcf.fund','rmcclain@revolution-es.com','dchero@beusaenergy.com','cfacchine@revolution-es.com','radams@beusaenergy.com','jhutchins@revolution-es.com'];   // Collections (20+ day past-due)
var EMAIL_COLS = [
  {key:'poReq',       label:'PO Request CC',  def:DEFAULT_NOTIFY_CC},
  {key:'invoice',     label:'Invoice CC',     def:DEFAULT_NOTIFY_CC},
  {key:'reminder',    label:'Reminder CC',    def:DEFAULT_NOTIFY_CC},
  {key:'collections', label:'Collections CC', def:DEFAULT_AR_CC}
];

/* column aliases (all lower-case) */
var A = {
  date:['invoice date','date','billing date'],
  inv:['invoice #','invoice','invoice number','inv #','inv#','invoice no'],
  unit:['billing unit','unit'],
  operator:['operator'],
  location:['pad','location','well','pad / location','pad/location'],
  disc:['category','disc','service','type','description'],
  amount:['amount billed','amount','total billed','billed','total','invoice amount'],
  signed:['signed'],
  paid:['paid'],
  status:['invoice status','status'],
  po:['po #','po#','customer po','customer po #'],
  poReq:['po request #','po request number','po request','po req #','po req','po request no'],
  reminder:['sent / reminders','sent/reminders','reminders','reminder sent','reminder'],
  notes:['notes','note'],
  lines:['line items','line items json','lineitems'],
  fleet:['fleet #','fleet'],
  cName:['supervisor','supervisor name'],
  cEmail:['supervisor email'],
  cPhone:['supervisor phone'],
  terms:['payment terms','terms'],
  paidDate:['date paid','paid date','paid on'],
  sentDate:['invoice sent date','sent date','date sent'],
  poReqPdf:['po request pdf','po request pdf link'],
  invPdf:['invoice pdf','invoice pdf link'],
  poPdf:['po assigned pdf','approved po pdf','customer po pdf'],   // approved customer-PO PDF (filed by Inbox auto-file)
  sgnPdf:['signed invoice pdf','signed pdf'],                      // signed-invoice PDF (filed by Inbox auto-file)
  inbox:['inbox','inbox flag','inbox status']                     // "PO received — confirm" / "Signed — confirm"
};

function doGet(e){
  var a=(e&&e.parameter&&e.parameter.action)||'summary';
  if(a==='schedule')  return json_(getSchedule_());
  if(a==='directory') return json_(getDirectory_());
  if(a==='lists')     return json_(getLists_());
  if(a==='emails')    return json_(getEmails_());
  if(a==='inspect')   return json_(inspect_());
  if(a==='sheetstats') return json_(sheetStats_());
  if(a==='optimizePreview') return json_(optimizeTracker_(true));          // read-only dry run of #9
  if(a==='verifyOptimize') return json_(verifyOptimize_());                  // read-only: compare G/Q/S to the pre-optimize backup                          // read-only workbook weight report (#9)
  if(a==='logins')    return json_(getLogins_(e));
  if(a==='bootstrap') return cachedJson_('boot', getBootstrap_, e);
  if(a==='pending')   return cachedJson_('pend', getPending_, e);          // #10: small feed for the Fleet Tracker's Pending Invoices tab          // #3: schedule+directory+lists+emails in ONE call
  return cachedJson_('sum', getSummary_, e);                                   // #1: cached summary
}
/* ============================ SERVER CACHE (perf #1/#3, 2026-09-23) ============================
   Responses are cached in CacheService, keyed on the workbook's Drive "last modified" stamp plus a
   generation counter that every write through this web app bumps. Any change to the sheet — a save
   here, a trigger, or a hand edit in Google Sheets — changes the key, so stale data is never served.
   Values are chunked because CacheService caps each value at 100 KB. Add &fresh=1 to bypass. */
var CACHE_TTL = 21600;                // 6 h max; freshness comes from the key, not the TTL
var CHUNK = 80000;
function cacheStamp_(){
  var c=CacheService.getScriptCache(), gen=c.get('gen')||'0', mod='';
  try{ mod=String(DriveApp.getFileById(BOOK_ID).getLastUpdated().getTime()); }catch(e){ mod=String(Math.floor(Date.now()/60000)); }  // fallback: 1-min buckets
  return mod+'.'+gen;
}
function bustCache_(){ try{ var c=CacheService.getScriptCache(); c.put('gen', String(Date.now()), CACHE_TTL); }catch(e){} }
function cachePutBig_(key,str){
  var c=CacheService.getScriptCache(), parts={}, n=Math.ceil(str.length/CHUNK)||1;
  for(var i=0;i<n;i++) parts[key+'_'+i]=str.substr(i*CHUNK,CHUNK);
  parts[key+'_n']=String(n);
  try{ c.putAll(parts, CACHE_TTL); }catch(e){}
}
function cacheGetBig_(key){
  var c=CacheService.getScriptCache(), n=Number(c.get(key+'_n')||0); if(!n) return null;
  var ks=[]; for(var i=0;i<n;i++) ks.push(key+'_'+i);
  var got=c.getAll(ks), out=''; for(var j=0;j<n;j++){ if(got[ks[j]]==null) return null; out+=got[ks[j]]; }
  return out;
}
function cachedJson_(name, builder, e){
  var fresh = e && e.parameter && e.parameter.fresh;
  var key = name+'@'+cacheStamp_();
  if(!fresh){ var hit=cacheGetBig_(key); if(hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON); }
  var str=JSON.stringify(builder());
  cachePutBig_(key,str);
  return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON);
}
/* #10: only what the Fleet Tracker needs — current-year invoices with an Invoice #, not paid and not signed. */
function getPending_(){
  var yr=Utilities.formatDate(new Date(),sheetTz_(),'yyyy'), rows=getSummary_().rows.filter(function(r){
    return r.inv && r.paid!=='Yes' && r.signed!=='Yes' && String(r.date||'').slice(0,4)===yr; });
  return { rows: rows.map(function(r){ return {inv:r.inv,date:r.date,amount:r.amount,fleet:r.fleet,operator:r.operator,location:r.location,
    disc:r.disc,notes:String(r.notes||'').split('\n')[0],pdfUrl:r.pdfUrl,paid:r.paid,signed:r.signed}; }) };
}
function getBootstrap_(){
  function safe(f){ try{ return f(); }catch(err){ return null; } }
  return { schedule:safe(getSchedule_), directory:safe(getDirectory_), lists:safe(getLists_), emails:safe(getEmails_) };
}
function doPost(e){
  var T0=Date.now(), TM={};                                                    // per-step timings → "_ms" in the reply
  try{ var body=JSON.parse(e.postData.contents); var lock=LockService.getScriptLock(); lock.tryLock(20000); TM.lock=Date.now()-T0;
    try{ if(body.action==='logLogin') return json_({ok:true,row:logLogin_(body.payload||{})});
         if(body.action==='po'||body.action==='invoice'||body.action==='save'){
           var t1=Date.now(), loc=(body.action==='save')?saveDoc_(body.payload||{}):appendDoc_(body.payload||{},body.action);
           TM.write=Date.now()-t1; bustCache_(); var rowN=(loc&&loc.row)?loc.row:loc, tab=(loc&&loc.tab)?loc.tab:WRITE_TAB;
           var t2=Date.now(), rec=rowRecord_(tab,rowN); TM.readBack=Date.now()-t2; TM.total=Date.now()-T0;
           return json_({ok:true,row:rowN,rec:rec,_ms:TM}); }                     // #8: send back the saved row
         if(body.action==='update'){ var ok=updateRow_(body.payload||{}); if(ok) bustCache_(); TM.total=Date.now()-T0; return json_({ok:ok,_ms:TM}); }
         if(body.action==='delete'){ var dr=deleteDoc_(body.payload||{}); if(dr) bustCache_(); return json_({ok:!!dr,row:(dr||0),tab:WRITE_TAB}); }
         if(body.action==='tidy' && body.payload && body.payload.confirm==='TIDY'){ var msg=tidyBillingTracker_(false); bustCache_(); return json_({ok:true,msg:msg}); }
         return json_({error:'unknown action'}); }
    finally{ lock.releaseLock(); }
  }catch(err){ return json_({error:String(err)}); }
}

/* ============================ SUMMARY ============================ */
function getSummary_(){
  var ss=SpreadsheetApp.openById(BOOK_ID), out=[];
  TRK_TABS.forEach(function(name){
    var sh=ss.getSheetByName(name); if(!sh||sh.getLastRow()<2) return;
    var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
    var hr=trackerHeaderRow_(vals); if(hr<0) return; var m=hdr_(vals[hr]);
    var ci=mapCols_(m);
    for(var r=hr+1;r<vals.length;r++){ var rec=summaryRow_(vals[r],ci,name,r+1); if(rec) out.push(rec); }
  });
  return { rows:out };
}
/* One tracker row → the summary record the dashboard uses. _row/_tab let the dashboard patch a single record in place. */
function summaryRow_(v,ci,name,rowNum){
      var inv=g_(v,ci.inv), amt=g_(v,ci.amount), poReq=g_(v,ci.poReq);
      if(!inv && !amt && !poReq) return null;
      var status=String(g_(v,ci.status)||'');
      var paid = (paid_(g_(v,ci.paid))==='Yes' || /paid|collected/i.test(status)) ? 'Yes':'No';
      var pk = parsePack_(g_(v,ci.lines));
      return { inv:String(inv||'').trim(), date:fmtDate_(g_(v,ci.date)), amount:Number(amt)||0,
        start:pk.start||'', end:pk.end||'',
        signed:x_(g_(v,ci.signed)), poReq:String(poReq||''), poAssigned: g_(v,ci.po)?'Yes':x_(g_(v,ci.poAssigned)),
        reminderSent:x_(g_(v,ci.reminder)), paid:paid, invoiceStatus:status,
        unit:unitText_(g_(v,ci.unit), inv), po:String(g_(v,ci.po)||''),
        operator:String(g_(v,ci.operator)||''), location:String(g_(v,ci.location)||''), disc:String(g_(v,ci.disc)||''),
        fleet:String(g_(v,ci.fleet)||''),
        contactName:String(g_(v,ci.cName)||''), contactEmail:String(g_(v,ci.cEmail)||''), contactPhone:String(g_(v,ci.cPhone)||''),
        terms:String(g_(v,ci.terms)||''), paidDate:fmtDate_(g_(v,ci.paidDate)), sentDate:fmtDate_(g_(v,ci.sentDate)),
        pdfUrl:String(g_(v,ci.invPdf)||g_(v,ci.poReqPdf)||''),
        poPdf:String(g_(v,ci.poPdf)||''), sgnPdf:String(g_(v,ci.sgnPdf)||''), inboxFlag:String(g_(v,ci.inbox)||''),
        lineItems:pk.lines, notes:(pk.notes || String(g_(v,ci.notes)||'')),
        _tab:name, _row:rowNum };
}
/* Read ONE tracker row and return its summary record (used after a save — #8). */
function rowRecord_(tab,rowN){
  try{ rowN=Number(rowN); if(!rowN) return null;
    var sh=SpreadsheetApp.openById(BOOK_ID).getSheetByName(tab||WRITE_TAB); if(!sh) return null;
    var lc=sh.getLastColumn(), top=sh.getRange(1,1,Math.min(sh.getLastRow(),15),lc).getValues();
    var hr=trackerHeaderRow_(top); if(hr<0) return null;
    var ci=mapCols_(hdr_(top[hr]));
    return summaryRow_(sh.getRange(rowN,1,1,lc).getValues()[0],ci,tab||WRITE_TAB,rowN);
  }catch(e){ return null; }
}
function mapCols_(m){
  var ci={}; Object.keys(A).forEach(function(k){ ci[k]=col_(m,A[k]); });
  ci.poAssigned=col_(m,['po assigned']);
  return ci;
}
function unitText_(u,inv){ var s=String(u||''); if(/765/.test(s)) return '765'; if(/755/.test(s)) return '755';
  var iv=String(inv||'').trim(); if(iv.charAt(0)==='5'&&iv.charAt(1)==='1') return '755'; if(iv.charAt(0)==='5'&&iv.charAt(1)==='0') return '765'; return '755'; }

/* ONE-TIME: relabel the Billing Unit column to "OPERATING 765" / "SERVICE 755".
   Safe & idempotent — only touches data rows where the unit is determinable, keeps the 765/755
   number (so every read still resolves correctly), and can be undone via File → Version history.
   Run it once from the Apps Script editor (Run ▸ relabelBillingUnit) after deploying this version. */
function relabelBillingUnit(){
  var ss=SpreadsheetApp.openById(BOOK_ID), changed=0, scanned=0;
  TRK_TABS.forEach(function(name){
    var sh=ss.getSheetByName(name); if(!sh||sh.getLastRow()<2) return;
    var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
    var hr=trackerHeaderRow_(vals); if(hr<0) return; var m=hdr_(vals[hr]);
    var ui=col_(m,A.unit), ii=col_(m,A.inv), ai=col_(m,A.amount), pri=col_(m,A.poReq);
    if(ui<0) return;
    for(var r=hr+1;r<vals.length;r++){
      var row=vals[r], inv=String(g_(row,ii)||'').trim(), amt=g_(row,ai), poReq=String(g_(row,pri)||'');
      if(!inv && !amt && !poReq) continue;                       // skip blank rows
      scanned++;
      var cur=String(row[ui]||'');
      var num = /765/.test(cur)?'765' : (/755/.test(cur)?'755' : null);
      if(!num){ if(inv.charAt(0)==='5'&&inv.charAt(1)==='1') num='755'; else if(inv.charAt(0)==='5'&&inv.charAt(1)==='0') num='765'; }
      if(!num) continue;                                         // can't determine — leave as-is
      var label = (num==='765')?'765 · Operations':'755 · Equipment';
      if(cur!==label){ sh.getRange(r+1, ui+1).setValue(label); changed++; }
    }
  });
  return 'Relabeled '+changed+' of '+scanned+' Billing Unit cell(s).';
}

/* ============================ INSPECT (verification) ============================ */
/* Read-only: size + formula weight of every tab, so we can see what the workbook recalculates on each save. */
function sheetStats_(){
  var ss=SpreadsheetApp.openById(BOOK_ID), out=[], VOL=/\b(NOW|TODAY|RAND|RANDBETWEEN|INDIRECT|OFFSET|IMPORTRANGE|IMPORTXML|IMPORTDATA|GOOGLEFINANCE)\s*\(/i;
  ss.getSheets().forEach(function(sh){
    var t=Date.now(), lr=sh.getLastRow(), lc=sh.getLastColumn(), f=0, refs=0, vol=0, arr=0, whole=0;
    if(lr>0&&lc>0){ sh.getRange(1,1,lr,lc).getFormulas().forEach(function(row){ row.forEach(function(x){ if(!x) return; f++;
      if(/Billing Tracker/i.test(x)) refs++; if(VOL.test(x)) vol++; if(/ARRAYFORMULA|QUERY\s*\(|FILTER\s*\(/i.test(x)) arr++;
      if(/![A-Z]{1,3}:[A-Z]{1,3}\b|\b[A-Z]{1,3}:[A-Z]{1,3}\b/.test(x)) whole++; }); }); }
    out.push({tab:sh.getName(), hidden:sh.isSheetHidden(), maxRows:sh.getMaxRows(), maxCols:sh.getMaxColumns(), lastRow:lr, lastCol:lc,
      formulas:f, refsTracker:refs, volatile:vol, arrayOrQuery:arr, wholeColumnRefs:whole, readMs:Date.now()-t});
  });
  return {tabs:out};
}
function inspect_(){
  var ss=SpreadsheetApp.openById(BOOK_ID), out={book:ss.getName(), tabs:[]};
  TRK_TABS.forEach(function(name){
    var sh=ss.getSheetByName(name); if(!sh){ out.tabs.push({tab:name, error:'missing'}); return; }
    var lastR=Math.min(sh.getLastRow(),8), lastC=sh.getLastColumn();
    if(lastR<1){ out.tabs.push({tab:name, error:'empty'}); return; }
    var vals=sh.getRange(1,1,lastR,lastC).getValues();
    var hr=trackerHeaderRow_(vals); var m= hr>=0?hdr_(vals[hr]):{};
    var headers=[]; (hr>=0?vals[hr]:(vals[0]||[])).forEach(function(x,i){ if(String(x).trim()!=='') headers.push(colLetter_(i)+'='+String(x).trim()); });
    var ci=mapCols_(m), detected={}; Object.keys(ci).forEach(function(k){ if(ci[k]>=0) detected[k]=colLetter_(ci[k])+' ('+String(vals[hr][ci[k]]).trim()+')'; });
    var samples=[]; for(var r=hr+1;r<Math.min(vals.length,hr+4);r++){ samples.push(vals[r].slice(0,Math.min(lastC,26))); }
    out.tabs.push({tab:name, headerRow:(hr+1), headers:headers, detected:detected, sampleRows:samples});
  });
  return out;
}
function colLetter_(i){ var s=''; i=Number(i); do{ s=String.fromCharCode(65+(i%26))+s; i=Math.floor(i/26)-1; }while(i>=0); return s; }

/* ============================ SCHEDULE + DIRECTORY ============================ */
function getSchedule_(){ return { '755':readSch_(SCH_755), '765':readSch_(SCH_765) }; }
function readSch_(name){
  var sh=SpreadsheetApp.openById(BOOK_ID).getSheetByName(name); if(!sh||sh.getLastRow()<2) return [];
  var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues(), m=hdr_(vals[0]);
  var iCat=col_(m,['schedule category','category']), iItem=col_(m,['schedule item','item']),
      iUom=col_(m,['unit of measure','unit','uom']), iRate=col_(m,['standard rate','rate']), iAct=col_(m,['active']);
  var out=[]; for(var r=1;r<vals.length;r++){ var v=vals[r], item=g_(v,iItem); if(!item) continue;
    if(iAct>=0 && String(v[iAct]).toLowerCase()==='no') continue;
    out.push([String(g_(v,iCat)||''),String(item),String(g_(v,iUom)||'EA'),(v[iRate]===''||v[iRate]==null)?null:Number(v[iRate])]); }
  return out;
}
function getDirectory_(){
  var sh=SpreadsheetApp.openById(BOOK_ID).getSheetByName(DIRECTORY); if(!sh||sh.getLastRow()<2) return {fleets:[]};
  var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues(), m=hdr_(vals[0]);
  var iF=col_(m,['fleet #','fleet']), iN=col_(m,['supervisor','contact','name']), iE=col_(m,['supervisor email','email']),
      iP=col_(m,['supervisor phone','phone']), iO=col_(m,['current operator','operator']);
  var out=[]; for(var r=1;r<vals.length;r++){ var v=vals[r], n=g_(v,iN); if(!n) continue;
    out.push({fleet:String(g_(v,iF)||''),name:String(n),email:String(g_(v,iE)||''),phone:String(g_(v,iP)||''),operator:String(g_(v,iO)||'')}); }
  return {fleets:out};
}

/* Dropdown source lists from the "Lists" tab: A=Operators, B=Category (Disc). The first cell holds "Label FirstValue". */
function getLists_(){
  var sh=SpreadsheetApp.openById(BOOK_ID).getSheetByName(LISTS_TAB);
  if(!sh||sh.getLastRow()<1) return {operators:[], disc:[]};
  return { operators: listCol_(sh,1,'Operators'), disc: listCol_(sh,2,'Category') };
}
function listCol_(sh,colIdx,label){
  var last=sh.getLastRow(); if(last<1||colIdx>sh.getLastColumn()) return [];
  var vals=sh.getRange(1,colIdx,last,1).getValues().map(function(r){return String(r[0]||'').trim();});
  var out=[];
  vals.forEach(function(v,i){
    if(!v) return;
    if(i===0 && label){ v=v.replace(new RegExp('^'+label+'\\b\\s*','i'),'').trim(); }  // strip the column-header label ("Operators" / "Operators (All)")
    if(!v || /^\(all\)$/i.test(v)) return;                                             // drop the header / "(All)" filter option
    if(out.indexOf(v)<0) out.push(v);
  });
  return out;
}
/* ============================ EMAIL LISTS (CC recipients per document type) ============================ */
/* One "Email Lists" tab drives who is CC'd on each document: A=PO Request, B=Invoice, C=Reminder, D=Collections.
   The tab is created + seeded with the current defaults the first time it is read (or Run ▸ seedEmailLists). */
function emailListsSheet_(){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(EMAIL_TAB);
  if(!sh) sh=ss.insertSheet(EMAIL_TAB);
  EMAIL_COLS.forEach(function(c,idx){
    var col=idx+1, last=Math.max(sh.getLastRow(),1);
    var vals=sh.getRange(1,col,last,1).getValues().map(function(r){return String(r[0]||'').trim();});
    if(!vals.some(function(v){return v.indexOf('@')>0;})){                               // column has no emails yet → seed defaults
      var rows=[[c.label]].concat(c.def.map(function(e){return [e];}));
      sh.getRange(1,col,rows.length,1).setValues(rows);
    }
  });
  try{ sh.setFrozenRows(1); sh.getRange(1,1,1,EMAIL_COLS.length).setFontWeight('bold'); sh.setColumnWidths(1,EMAIL_COLS.length,240); }catch(e){}
  return sh;
}
function readEmailCol_(sh,col,label){
  var last=sh.getLastRow(); if(last<1) return [];
  var vals=sh.getRange(1,col,last,1).getValues().map(function(r){return String(r[0]||'').trim();});
  var out=[];
  vals.forEach(function(v,i){
    if(!v) return;
    if(i===0){ v=v.replace(new RegExp('^'+label+'\\b\\s*','i'),'').trim(); }              // strip the header label
    if(v && v.indexOf('@')>0 && out.indexOf(v)<0) out.push(v);                            // keep only emails, dedup
  });
  return out;
}
function getEmails_(){
  var sh=emailListsSheet_(), out={};
  EMAIL_COLS.forEach(function(c,idx){ var l=readEmailCol_(sh,idx+1,c.label); out[c.key]=l.length?l:c.def.slice(); });
  return out;
}
/* Run this once from the editor to create + populate the Email Lists tab immediately (no redeploy needed). */
function seedEmailLists(){ emailListsSheet_(); return 'Email Lists tab is ready on the sheet — edit the PO Request / Invoice / Reminder / Collections columns there.'; }

/* ============================ GOOGLE DRIVE (save each PO Request / Invoice PDF) ============================ */
var MONTHS_=['January','February','March','April','May','June','July','August','September','October','November','December'];
function folderChild_(parent,name){ var it=parent.getFoldersByName(name); return it.hasNext()?it.next():parent.createFolder(name); }
function cleanName_(s){ return String(s==null?'':s).replace(/[\\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').trim(); }
/* Naming scheme — the leading ID is the match key that links the file to its tracker row; the rest
   is Operator - Pad/Location - Category - Billing Unit. Files are then sorted into a "765 · Operations"
   or "755 · Equipment" subfolder under each Year. Examples:
     Invoice     : "Invoice 50494 - Ascent - Charley Pad - Rig Up - 765.pdf"
     Signed      : "SIGNED - Invoice 50494 - Ascent - Charley Pad - Rig Up - 765.pdf"
     PO Request  : "EWS-POR-00022 - Ascent - Charley Pad - Rig Up - 765.pdf"
     Customer PO : "EWSO-PO-2518 - Ascent - Charley Pad - Rig Up - 765.pdf" */
function unitCode_(u){ u=String(u||''); return /765/.test(u)?'765':(/755/.test(u)?'755':''); }
function unitFolder_(u){ var c=unitCode_(u); return c==='765'?'765 · Operations':(c==='755'?'755 · Equipment':''); }
function schemeTail_(p){
  var parts=[p.operator,p.location,p.disc,unitCode_(p.unit)].map(cleanName_).filter(Boolean);
  return parts.length?(' - '+parts.join(' - ')):'';
}
function pdfFileName_(p,action){
  var tail=schemeTail_(p);
  if(action==='invoice') return cleanName_('Invoice '+(p.inv||p.poReq||'doc')+tail)+'.pdf';
  if(action==='signed')  return cleanName_('SIGNED - Invoice '+(p.inv||p.poReq||'doc')+tail)+'.pdf';
  if(action==='custpo')  return cleanName_((p.po||p.poReq||'doc')+tail)+'.pdf';
  return cleanName_((p.poReq||'doc')+tail)+'.pdf';   // 'po' → PO Request file
}
function savePdf_(p,action){
  if(!p.pdfB64) return '';
  try{
    var root=DriveApp.getFolderById(DRIVE_ROOT);
    var d=p.date?new Date(p.date):new Date(); if(isNaN(d.getTime())) d=new Date();
    var top=(action==='invoice')?'Invoice Request':'PO Requests';                 // the manual EWS Billing folders
    var folder=folderChild_(folderChild_(root,top),String(d.getFullYear()));       // EWS Billing / <top> / <Year>
    var uf=unitFolder_(p.unit); if(uf) folder=folderChild_(folder,uf);             // …/<Year>/<765 · Operations | 755 · Equipment>
    var fname=pdfFileName_(p,action);
    var ex=folder.getFilesByName(fname); while(ex.hasNext()){ ex.next().setTrashed(true); }   // keep one current version
    var file=folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.pdfB64),'application/pdf',fname));
    return file.getUrl();
  }catch(e){ return 'ERR:'+e; }
}

/* ============================ APPEND / UPDATE (Billing Tracker tab) ============================ */
function appendDoc_(p,action){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(WRITE_TAB); if(!sh) return 0;
  var hr=trackerHeaderRow_(sh.getRange(1,1,Math.min(sh.getLastRow(),15),sh.getLastColumn()).getValues());
  if(hr<0) hr=0;
  var m=ensureLineItemsCol_(sh,hr);
  var amount=p.total!=null?Number(p.total):(p.lines||[]).reduce(function(a,l){return a+(Number(l.total)||0);},0);
  var linesJson=JSON.stringify({start:p.start||'', end:p.end||'', notes:p.notes||'', lines:(p.rawLines||p.lines||[])});  // pack: header dates/notes + line items
  var pdfUrl=savePdf_(p,action), pdfOk=(pdfUrl && pdfUrl.indexOf('ERR:')!==0)?pdfUrl:'';

  if(action==='invoice' && p.poReq){
    var found=poReqRowFree_(findRowByPoReq_(ss,p.poReq), p.inv);
    if(found){ var fm=ensureLineItemsCol_(found.sh,found.hr);
      new RowPatch_(found.sh,found.row,fm).set(A.inv,p.inv).set(A.amount,amount).set(A.po,p.po).set(A.lines,linesJson)
        .set(A.notes,p.notes).set(A.fleet,p.fleet).set(A.cEmail,p.contactEmail).set(A.invPdf,pdfOk).set(A.status,'Invoiced').flush();
      return {row:found.row, tab:found.sh.getName()};
    }
  }
  // Find the FIRST blank data row (key columns empty) so new entries slot in with the data —
  // NOT below the pre-filled formula columns (which can push appendRow thousands of rows down).
  var lastR=sh.getLastRow();
  var iInv=col_(m,A.inv), iPo=col_(m,A.poReq), iAmt=col_(m,A.amount), iDate=col_(m,A.date);
  var keyCols=[iInv,iPo,iAmt,iDate].filter(function(c){return c>=0;});
  var target=-1;
  if(lastR>hr+1 && keyCols.length){
    var maxKey=Math.max.apply(null,keyCols)+1;
    var scan=sh.getRange(hr+2,1,lastR-(hr+1),maxKey).getValues();
    for(var r=0;r<scan.length;r++){ var blank=true;
      for(var k=0;k<keyCols.length;k++){ if(String(scan[r][keyCols[k]]||'').trim()!==''){ blank=false; break; } }
      if(blank){ target=hr+2+r; break; } }
  }
  if(target<0) target=lastR+1;
  if(target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), target - sh.getMaxRows());
  // Self-heal: if this row lacks the computed-column formulas, copy them (ref-adjusted) from the row above — so tidying can be aggressive without losing auto-calc.
  try{ if(target-1>=hr+2){ var lc2=sh.getLastColumn(),
      fa=sh.getRange(target-1,1,1,lc2).getFormulas()[0], fh=sh.getRange(target,1,1,lc2).getFormulas()[0];
      for(var c=0;c<fa.length;c++){ if(fa[c]&&fa[c].charAt(0)==='='&&!(fh[c]&&fh[c].charAt(0)==='='))
        sh.getRange(target-1,c+1).copyTo(sh.getRange(target,c+1),SpreadsheetApp.CopyPasteType.PASTE_FORMULA,false); } } }catch(e){}
  new RowPatch_(sh,target,m)
    .set(A.inv,p.inv).set(A.date, safeDate_(p.date)).set(A.amount,amount)
    .set(A.unit, p.unit==='765'?'765 · Operations':'755 · Equipment')   // Billing Unit label (still carries 765/755 so reads stay correct)
    .set(A.operator,p.operator).set(A.location,p.location).set(A.disc,p.disc).set(A.fleet,p.fleet)
    .set(A.poReq,p.poReq).set(A.po,p.po).set(A.lines,linesJson)
    .set(A.cName,p.contactName||p.contact).set(A.cEmail,p.contactEmail).set(A.cPhone,p.contactPhone)
    .set(action==='invoice'?A.invPdf:A.poReqPdf, pdfOk)
    .set(A.status, action==='invoice'?'Invoiced':'Requested')
    .set(A.notes, p.notes || [p.operator,p.location,p.disc].filter(Boolean).join(' - '))
    .flush();                                                            // one write for the whole row
  return {row:target, tab:sh.getName()};
}
function safeDate_(v){                                              // "2026-09-23" → that calendar day in the sheet's zone
  var m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m){ try{ var p=Utilities.parseDate(m[0],sheetTz_(),'yyyy-MM-dd'); if(!isNaN(p.getTime())) return p; }catch(e){} }
  var d = v ? new Date(v) : new Date(); if(isNaN(d.getTime()) || d.getFullYear()<2020 || d.getFullYear()>2100) d=new Date(); return d; }

/*************************************************************************************************
 * TIDY THE BILLING TRACKER — trims the thousands of empty formula-template rows.
 *   Run ▸ tidyPreview   first: reports what it WOULD do, changes nothing.
 *   Run ▸ tidyBillingTracker : keeps your data + a 50-row formula buffer, deletes the empty tail.
 *   SAFETY: never deletes at/above (last data row + buffer). Back up first (File ▸ Version history).
 *   New entries still auto-calculate — the append path self-heals the formulas past the buffer.
 *************************************************************************************************/
function tidyPreview(){ return tidyBillingTracker_(true); }
function tidyBillingTracker(){ return tidyBillingTracker_(false); }
function tidyBillingTracker_(preview){
  var sh=SpreadsheetApp.openById(BOOK_ID).getSheetByName(WRITE_TAB);
  var lastRow=sh.getLastRow(), lastC=sh.getLastColumn();
  var top=sh.getRange(1,1,Math.min(15,lastRow),lastC).getValues();
  var hr=trackerHeaderRow_(top); if(hr<0) hr=0;
  var m=hdr_(top[hr]);
  var iInv=col_(m,A.inv), iPo=col_(m,A.poReq), iAmt=col_(m,A.amount), iDate=col_(m,A.date);
  var keyCols=[iInv,iPo,iAmt,iDate].filter(function(c){return c>=0;});
  if(!keyCols.length) return 'Could not locate the key columns — nothing changed.';
  var maxKey=Math.max.apply(null,keyCols)+1;
  var vals=sh.getRange(1,1,lastRow,maxKey).getValues();
  var lastData=hr+1;
  for(var r=hr+1;r<vals.length;r++){ for(var k=0;k<keyCols.length;k++){ if(String(vals[r][keyCols[k]]||'').trim()!==''){ lastData=r+1; break; } } }
  var BUFFER=50, keepTo=lastData+BUFFER, maxRows=sh.getMaxRows(), toDelete=Math.max(0, maxRows-keepTo);
  var msg='Billing Tracker — last data row '+lastData+', sheet has '+maxRows+' rows. '
    +(preview?'WOULD keep':'Kept')+' through row '+keepTo+' ('+BUFFER+' template rows) and '
    +(preview?'WOULD delete ':'deleted ')+toDelete+' empty row(s).';
  if(!preview && toDelete>0) sh.deleteRows(keepTo+1, toDelete);
  return msg;
}

function updateRow_(p){
  if(!p.inv) return false;
  var ss=SpreadsheetApp.openById(BOOK_ID);
  var isPaid=p.field==='paid';
  var target = p.field==='signed'?A.signed : p.field==='poAssigned'?['po assigned'] : isPaid?A.paid : A.reminder;
  var mark=(String(p.value).toLowerCase().charAt(0)==='y')?'Yes':'No';
  var f=findRowBy_(ss,A.inv,p.inv); if(!f) return false;                      // #7: one-column lookup
  var iCol=col_(f.m,target);
  if(iCol>=0) f.sh.getRange(f.row,iCol+1).setValue(mark==='Yes'?(isPaid?'Yes':'X'):'');
  if(isPaid){ var iSt=col_(f.m,A.status);
    if(iSt>=0){ var stc=f.sh.getRange(f.row,iSt+1), cur=String(stc.getValue()||'').trim();
      if(mark==='Yes') stc.setValue('Paid');
      else if(/^paid$/i.test(cur)) stc.setValue(''); } }
  return true;
}

/* Delete a single erroneous entry — only from the current Billing Tracker tab (history is never touched). */
function deleteDoc_(p){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(WRITE_TAB); if(!sh) return false;
  var h=hdrInfo_(sh); if(!h) return false;
  var inv=String(p.inv||'').trim().toLowerCase(), poReq=String(p.poReq||'').trim().toLowerCase();
  if(!inv && !poReq) return false;
  var iInv=col_(h.m,A.inv), iPo=col_(h.m,A.poReq);
  var invs=keyCol_(sh,h.hr,iInv), pos=keyCol_(sh,h.hr,iPo), n=Math.max(invs.length,pos.length);   // #7: two key columns only
  for(var r=0;r<n;r++){
    var rInv=invs[r]||'', rPo=pos[r]||'';
    var ok=(inv? rInv===inv : true) && (poReq? rPo===poReq : true) && ((inv&&rInv===inv)||(poReq&&rPo===poReq));
    if(ok){ var rowN=h.hr+2+r; sh.deleteRow(rowN); return rowN; }   // row number (truthy) so the dashboard can shift its local row refs
  }
  return false;
}

/* ============================ HELPERS ============================ */
function trackerHeaderRow_(vals){
  for(var i=0;i<Math.min(vals.length,15);i++){ var row=vals[i].map(function(x){return String(x).trim().toLowerCase();});
    if(row.indexOf('invoice #')>=0||row.indexOf('invoice')>=0||row.indexOf('invoice date')>=0||(row.indexOf('billing unit')>=0&&row.indexOf('signed')>=0)) return i; }
  return -1;
}
function hdr_(h){ var m={}; h.forEach(function(x,i){ var k=String(x).trim().toLowerCase(); if(k!=='' && !(k in m)) m[k]=i; }); return m; }
function col_(m,names){ for(var i=0;i<names.length;i++){ var k=String(names[i]).toLowerCase(); if(k in m) return m[k]; } return -1; }
function g_(v,i){ return i>=0?v[i]:''; }
function ensureLineItemsCol_(sh,hr){
  var m=hdr_(sh.getRange(hr+1,1,1,sh.getLastColumn()).getValues()[0]);
  if(col_(m,A.lines)<0){ var i=sh.getLastColumn(); sh.getRange(hr+1,i+1).setValue('Line Items'); m['line items']=i; }
  return m;
}
/* ============================ FAST ROW LOOKUPS (perf #7, 2026-09-23) ============================
   Instead of reading every column of every row, read the header block once per execution (memoized)
   and then only the ONE key column being searched. Current tab first, history tab second. */
var HDR_MEMO_={};
function hdrInfo_(sh){
  var k=sh.getName(); if(HDR_MEMO_[k]) return HDR_MEMO_[k];
  if(sh.getLastRow()<2) return null;
  var top=sh.getRange(1,1,Math.min(sh.getLastRow(),15),sh.getLastColumn()).getValues();
  var hr=trackerHeaderRow_(top); if(hr<0) return null;
  return (HDR_MEMO_[k]={hr:hr, m:hdr_(top[hr])});
}
function keyCol_(sh,hr,ci){                                   // values of one column, data rows only
  var n=sh.getLastRow()-(hr+1); if(n<1||ci<0) return [];
  return sh.getRange(hr+2,ci+1,n,1).getValues().map(function(r){return String(r[0]==null?'':r[0]).trim().toLowerCase();});
}
function findRowBy_(ss,names,val,tabs){
  var q=String(val==null?'':val).trim().toLowerCase(); if(!q) return null;
  var list=tabs||TRK_TABS;
  for(var t=0;t<list.length;t++){
    var sh=ss.getSheetByName(list[t]); if(!sh) continue;
    var h=hdrInfo_(sh); if(!h) continue;
    var ci=col_(h.m,names); if(ci<0) continue;
    var idx=keyCol_(sh,h.hr,ci).indexOf(q);
    if(idx>=0) return {sh:sh,row:h.hr+2+idx,hr:h.hr,m:h.m};
  }
  return null;
}
function findRowByPoReq_(ss,poReq){ return findRowBy_(ss,A.poReq,poReq); }
function findRowByInv_(ss,inv){ return findRowBy_(ss,A.inv,inv); }
/* A row found by PO Request # may be reused only if it has no Invoice # yet, or the SAME one.
   (One PO Request can carry several invoices — never overwrite a different invoice's row.) 2026-09-23 */
function poReqRowFree_(found,inv){
  if(!found) return null; inv=String(inv||'').trim(); if(!inv) return found;
  var m=found.m||hdrInfo_(found.sh).m;
  var i=col_(m,A.inv); if(i<0) return found;
  var cur=String(found.sh.getRange(found.row,i+1).getValue()||'').trim();
  return (!cur || cur.toLowerCase()===inv.toLowerCase()) ? found : null;
}
/* #6: batch a row's cell writes. Changed columns are grouped into contiguous runs and each run is written
   with ONE setValues call (typically 3–4 writes instead of ~15 single-cell writes). Columns that aren't being
   changed are never touched, so formula / computed columns are left exactly as they are. */
function RowPatch_(sh,row,m){ this.sh=sh; this.row=row; this.m=m; this.p={}; }
RowPatch_.prototype.set=function(names,val){ var i=col_(this.m,names); if(i>=0 && val!=='' && val!=null) this.p[i]=val; return this; };
RowPatch_.prototype.flush=function(){
  var ks=Object.keys(this.p).map(Number).sort(function(a,b){return a-b;}); if(!ks.length) return;
  var runs=[], cur=[ks[0]];
  for(var i=1;i<ks.length;i++){ if(ks[i]===ks[i-1]+1) cur.push(ks[i]); else { runs.push(cur); cur=[ks[i]]; } }
  runs.push(cur);
  var self=this;
  runs.forEach(function(r){ self.sh.getRange(self.row,r[0]+1,1,r.length).setValues([r.map(function(c){return self.p[c];})]); });
};
function setCell_(sh,row,m,names,val){ var i=col_(m,names); if(i>=0 && val!==''&&val!=null) sh.getRange(row,i+1).setValue(val); }
/* Upsert a document by PO Request # (or Invoice #) — update the row in place if it exists, else write a new one. Never duplicates. */
function saveDoc_(p){
  var ss=SpreadsheetApp.openById(BOOK_ID);
  var amount=p.total!=null?Number(p.total):(p.lines||[]).reduce(function(a,l){return a+(Number(l.total)||0);},0);
  var linesJson=JSON.stringify({start:p.start||'', end:p.end||'', notes:p.notes||'', lines:(p.rawLines||p.lines||[])});
  var found = p.inv ? findRowByInv_(ss,p.inv) : null;                                  // invoice # is the strongest key
  if(!found && p.poReq) found = poReqRowFree_(findRowByPoReq_(ss,p.poReq), p.inv);   // PO Request row only if not another invoice's
  if(found){
    var fm=ensureLineItemsCol_(found.sh,found.hr);
    new RowPatch_(found.sh,found.row,fm)
      .set(A.inv,p.inv).set(A.poReq,p.poReq).set(A.po,p.po).set(A.amount,amount)
      .set(A.operator,p.operator).set(A.location,p.location).set(A.disc,p.disc).set(A.fleet,p.fleet)
      .set(A.date,safeDate_(p.date)).set(A.lines,linesJson).set(A.notes,p.notes)
      .set(A.cName,p.contactName||p.contact).set(A.cEmail,p.contactEmail).set(A.cPhone,p.contactPhone)
      .set(A.status, p.inv?'Invoiced':'Requested')
      .flush();                                                          // one write instead of ~15
    return {row:found.row, tab:found.sh.getName()};
  }
  return appendDoc_(p, p.inv?'invoice':'po');   // not on the sheet yet → create it (no duplicate)
}
/* ============================ ACCESS LOG (sign-in audit) ============================ */
function logLogin_(p){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(LOG_TAB);
  if(!sh){ sh=ss.insertSheet(LOG_TAB); sh.getRange(1,1,1,4).setValues([['Timestamp','Email','Name','Browser']]); sh.setFrozenRows(1);
    try{ sh.getRange(2,1,sh.getMaxRows()-1,1).setNumberFormat('@'); }catch(e){} }        // keep timestamps as literal text
  var tz=ss.getSpreadsheetTimeZone()||'America/New_York';
  var ts=Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');                     // server time = authoritative
  sh.appendRow([ts, String(p.email||''), String(p.name||''), String(p.browser||p.ua||'')]);
  return sh.getLastRow();
}
function getLogins_(e){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(LOG_TAB);
  if(!sh || sh.getLastRow()<2) return {logins:[]};
  var want=Math.min(sh.getLastRow()-1, 500);
  var vals=sh.getRange(sh.getLastRow()-want+1,1,want,4).getValues();
  var out=vals.map(function(r){ return {ts:String(r[0]), email:String(r[1]), name:String(r[2]), browser:String(r[3])}; });
  out.reverse();   // newest first
  return {logins:out};
}
function parseLines_(v){ var s=String(v||'').trim(); if(!s||s.charAt(0)!=='[') return []; try{ var a=JSON.parse(s); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
/* Parse the Line Items cell — supports the old plain array AND the new {start,end,notes,lines} pack. */
function parsePack_(v){ var s=String(v||'').trim(); if(!s) return {lines:[]};
  try{ var o=JSON.parse(s);
    if(Array.isArray(o)) return {lines:o};
    if(o && typeof o==='object') return {lines:Array.isArray(o.lines)?o.lines:[], start:o.start||'', end:o.end||'', notes:o.notes||''};
  }catch(e){}
  return {lines:[]}; }
function x_(v){ var s=String(v||'').trim().toUpperCase(); return (s==='X'||s.charAt(0)==='Y'||s==='TRUE'||s==='1')?'Yes':'No'; }
function paid_(v){ var s=String(v||'').trim().toLowerCase(); if(!s) return 'No'; if(s==='no'||s==='n'||s==='false'||s==='0') return 'No'; return 'Yes'; }
/* Dates are formatted in the SPREADSHEET's time zone (not the script's) so the dashboard shows exactly the
   date that's in the cell — the two zones differ, which made every date read one day early (fixed 2026-09-23). */
var SHEET_TZ_=null;
function sheetTz_(){ if(!SHEET_TZ_){ try{ SHEET_TZ_=SpreadsheetApp.openById(BOOK_ID).getSpreadsheetTimeZone(); }catch(e){} SHEET_TZ_=SHEET_TZ_||Session.getScriptTimeZone(); } return SHEET_TZ_; }
function fmtDate_(d){ if(d instanceof Date) return Utilities.formatDate(d,sheetTz_(),'yyyy-MM-dd'); return d?String(d):''; }
function json_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/*************************************************************************************************
 * BILLING AUTOPILOT  — runs on a daily time trigger, chases every open invoice automatically.
 *   • 7+ days unsigned  → signature reminder (SIGN & RETURN)
 *   • 20+ days unpaid    → collections reminder (PAST DUE)
 *   • Attaches the invoice PDF from Drive, throttled so nothing is nagged more than once a week
 *   • Emails Chad a daily AR digest (open count, $ outstanding, 60+ day escalations, aging PO Requests)
 *
 * SETUP (once): open this project → Run ▸ installAutopilot  (approve the Gmail/Drive prompt).
 *   Preview first without sending anything:  Run ▸ autopilotPreview  (writes nothing, returns counts).
 *   MODE starts as 'draft' — it creates Gmail drafts for you to review + send.  When you trust it,
 *   set AUTOPILOT.MODE = 'send' below and it will send automatically (from your @revolution-es.com).
 *   Turn it off any time:  Run ▸ removeAutopilot.
 *************************************************************************************************/
var AUTOPILOT = {
  MODE: 'draft',                                 // 'draft' = create drafts to review (safe default) · 'send' = auto-send
  DIGEST_TO: 'cfacchine@revolution-es.com',      // who gets the daily AR digest
  HOUR: 7,                                        // trigger hour (local)
  SIG_DAYS: 7,                                    // signature reminder after N days unsigned
  COLLECT_DAYS: 20,                               // collections reminder after N days unpaid
  ESCALATE_DAYS: 60,                              // flag in digest for escalation
  AGING_PO_DAYS: 10,                              // PO Requests with no invoice this old → flag in digest
  REMIND_EVERY_DAYS: 7,                           // don't re-remind the same invoice more often than this
  CC: ['fwright@revolution-es.com','jkinder@revolution-es.com','mpuskarich@revolution-es.com','jason.jacobs@beusaenergy.com','servicerequest@beusaenergy.com','gkail@revolution-es.com','accountexecutive@mcf.fund','rmcclain@revolution-es.com','dchero@beusaenergy.com','cfacchine@revolution-es.com','radams@beusaenergy.com','jhutchins@revolution-es.com'],
  LOG_TAB: 'Autopilot Log'
};

function installAutopilot(){
  removeAutopilot();
  ScriptApp.newTrigger('autopilotRun').timeBased().everyDays(1).atHour(AUTOPILOT.HOUR).create();
  return 'Autopilot installed — runs daily ~'+AUTOPILOT.HOUR+':00. Current MODE: '+AUTOPILOT.MODE+(AUTOPILOT.MODE==='draft'?' (drafts only — review in Gmail).':' (auto-send).');
}
function removeAutopilot(){
  var n=0; ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='autopilotRun'){ ScriptApp.deleteTrigger(t); n++; } });
  return 'Removed '+n+' autopilot trigger(s).';
}
function autopilotPreview(){ return autopilotRun(true); }   // dry-run: sends/drafts NOTHING, returns what it would do

function autopilotRun(preview){
  var data=getSummary_().rows, log=apLog_(), today=new Date();
  var em = preview ? null : getEmails_();                        // CC lists from the Email Lists tab (once per run)
  var did={sig:0,collect:0,skipped:0}, escalations=[], agingPO=[];
  data.forEach(function(x){
    if(String(x.paid)==='Yes') return;
    var age=apDays_(x.date,today), sigAge=x.sentDate?apDays_(x.sentDate,today):age;
    var key=String(x.inv||x.poReq||'').toLowerCase(); if(!key) return;
    if(x.inv && age>=AUTOPILOT.ESCALATE_DAYS) escalations.push(x);
    if(!x.inv && x.poReq && age>=AUTOPILOT.AGING_PO_DAYS) agingPO.push(x);
    var type=null;
    if(x.inv && String(x.signed)!=='Yes' && sigAge>=AUTOPILOT.SIG_DAYS) type='signature';
    else if(x.inv && age>=AUTOPILOT.COLLECT_DAYS) type='collections';
    if(!type) return;
    var last=log[key]; if(last && apDays_(last,today)<AUTOPILOT.REMIND_EVERY_DAYS){ did.skipped++; return; }
    if(preview){ (type==='signature')?did.sig++:did.collect++; return; }
    if(apSendReminder_(x,type,em)){ (type==='signature')?did.sig++:did.collect++; apLogWrite_(key,today,type,x.inv||x.poReq); }
  });
  if(!preview) apSendDigest_(did, escalations, agingPO, data);
  return { mode:AUTOPILOT.MODE, preview:!!preview, signatureReminders:did.sig, collectionsReminders:did.collect, skippedRecentlyReminded:did.skipped, escalations:escalations.length, agingPORequests:agingPO.length };
}

function apSendReminder_(x,type,em){
  try{
    var to=x.contactEmail||''; if(!to) return false;                       // need a supervisor email to send to
    var unit=(x.unit==='755')?'Evolution Well Services - 755':'Evolution Well Services Operating LLC - 765';
    var subj=(type==='signature'?'REMINDER · SIGN & RETURN · ':'PAST DUE · ')+x.operator+' - '+x.location+' - Invoice # '+x.inv;
    var ask=(type==='signature')?'please review and SIGN AND RETURN the attached invoice':'this invoice is past due — please remit payment or advise on status';
    var body='Hello '+(x.contactName||x.operator)+',\n\nFollowing up on the invoice below — '+ask+'.\n\n'
      +'Billing Unit: '+unit+'\nInvoice #: '+x.inv+'\n'+x.operator+' - '+x.location+' - Fleet # '+x.fleet
      +'\nAmount: $'+(Number(x.amount)||0).toLocaleString()+'\nInvoice date: '+x.date+'\n\nThank you,\nRevolution Energy Services · Accounts Receivable';
    var cc=((type==='collections')?(em&&em.collections):(em&&em.reminder))||AUTOPILOT.CC;   // Collections CC for past-due, Reminder CC for signature
    var opts={ cc: cc.filter(function(e){return e.toLowerCase()!==to.toLowerCase();}).join(','), name:'Revolution Energy Services' };
    var atts=[]; var p1=apFetchPdf_(x.pdfUrl); if(p1) atts.push(p1); var p2=apFetchPdf_(x.poPdf); if(p2) atts.push(p2); if(atts.length) opts.attachments=atts;   // invoice + approved-PO PDF
    if(type==='signature') opts.htmlBody='<div style="font:14px/1.55 Arial,sans-serif;color:#1b1b1b"><div style="background:#b3261e;color:#fff;font-weight:700;font-size:15px;padding:11px 15px;border-radius:6px;margin-bottom:14px">PLEASE SIGN AND RETURN THE ATTACHED INVOICE</div>'+esc_(body).replace(/\n/g,'<br>')+'</div>';
    if(AUTOPILOT.MODE==='send') GmailApp.sendEmail(to,subj,body,opts); else GmailApp.createDraft(to,subj,body,opts);
    updateRow_({inv:x.inv, poReq:x.poReq, field:'reminder', value:'Yes'});
    return true;
  }catch(e){ return false; }
}
function apFetchPdf_(url){ try{ if(!url) return null; var m=String(url).match(/[-\w]{25,}/); return m?DriveApp.getFileById(m[0]).getBlob():null; }catch(e){ return null; } }
function esc_(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function apSendDigest_(did, escalations, agingPO, data){
  var open=data.filter(function(x){return String(x.paid)!=='Yes' && x.inv;});
  var outstanding=open.reduce(function(a,x){return a+(Number(x.amount)||0);},0);
  var L=[];
  L.push('BILLING AUTOPILOT — '+(AUTOPILOT.MODE==='send'?'reminders auto-sent':'reminder drafts created for review')+'   ('+fmtDate_(new Date())+')');
  L.push('');
  L.push('Reminders this run:  '+did.sig+' signature · '+did.collect+' collections'+(did.skipped?('   ('+did.skipped+' skipped — reminded within '+AUTOPILOT.REMIND_EVERY_DAYS+' days)'):''));
  L.push('Open invoices: '+open.length+'      Outstanding: $'+Math.round(outstanding).toLocaleString());
  L.push('');
  if(escalations.length){ L.push('** ESCALATE — '+escalations.length+' invoice(s) past '+AUTOPILOT.ESCALATE_DAYS+' days **');
    escalations.sort(function(a,b){return apDays_(b.date,new Date())-apDays_(a.date,new Date());}).slice(0,25).forEach(function(x){
      L.push('   • '+x.inv+'   '+x.operator+' - '+x.location+'   $'+(Number(x.amount)||0).toLocaleString()+'   ('+apDays_(x.date,new Date())+' days)'); }); L.push(''); }
  if(agingPO.length){ L.push('PO Requests awaiting an invoice ('+agingPO.length+'):');
    agingPO.slice(0,25).forEach(function(x){ L.push('   • '+x.poReq+'   '+x.operator+' - '+x.location+'   ('+apDays_(x.date,new Date())+' days)'); }); L.push(''); }
  if(AUTOPILOT.MODE!=='send') L.push('MODE = draft — open Gmail ▸ Drafts to review and send. Set AUTOPILOT.MODE="send" for full autopilot.');
  GmailApp.sendEmail(AUTOPILOT.DIGEST_TO, 'Billing Autopilot — '+open.length+' open · $'+Math.round(outstanding).toLocaleString()+' outstanding', L.join('\n'), {name:'Revolution Billing Autopilot'});
}

function apLog_(){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(AUTOPILOT.LOG_TAB), map={};
  if(!sh || sh.getLastRow()<2) return map;
  sh.getRange(2,1,sh.getLastRow()-1,2).getValues().forEach(function(r){ var k=String(r[1]||'').toLowerCase(), d=r[0];
    if(k && d instanceof Date && (!map[k]||d>map[k])) map[k]=d; });
  return map;
}
function apLogWrite_(key,date,type,label){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(AUTOPILOT.LOG_TAB);
  if(!sh){ sh=ss.insertSheet(AUTOPILOT.LOG_TAB); sh.appendRow(['Date','Key','Type','Doc','Mode']); }
  sh.appendRow([date,key,type,label,AUTOPILOT.MODE]);
}
function apDays_(d,today){ if(!d) return 0; var dd=(d instanceof Date)?d:new Date(String(d)+'T00:00:00'); if(isNaN(dd.getTime())) return 0; return Math.max(0,Math.round((today-dd)/86400000)); }

/*************************************************************************************************
 * INBOX AUTO-FILE (#1) — scans Gmail for customer replies carrying a PDF, files it to Drive by
 *   year (approved PO → "PO Assigned"/Year, signed invoice → "Invoice Signed"/Year), links it on
 *   the matching tracker row and flags it "… — confirm". It NEVER flips PO/Signed on its own —
 *   you do that with one click on the Pipeline. Safe to re-run; each Gmail message is filed once.
 *
 *   Run ▸ inboxScanPreview   → reports what it WOULD file, writes nothing.
 *   Run ▸ scanInbox          → files + links + flags for real.
 *   Run ▸ installInboxScan   → do it automatically every day (approve the Gmail/Drive prompt once).
 *   Run ▸ removeInboxScan    → stop the daily run.
 *************************************************************************************************/
function inboxScanPreview(){ return scanInbox_(true); }
function scanInbox(){ return scanInbox_(false); }
function installInboxScan(){
  removeInboxScan();
  ScriptApp.newTrigger('scanInbox').timeBased().everyDays(1).atHour(INBOX.HOUR).create();
  return 'Inbox auto-file installed — runs daily ~'+INBOX.HOUR+':00. Preview any time with inboxScanPreview.';
}
function removeInboxScan(){ var n=0; ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='scanInbox'){ ScriptApp.deleteTrigger(t); n++; } }); return 'Removed '+n+' inbox trigger(s).'; }

function scanInbox_(preview){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(WRITE_TAB);
  if(!sh) return 'Billing Tracker tab not found.';
  var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
  var hr=trackerHeaderRow_(vals); if(hr<0) hr=0;
  var m = preview ? hdr_(vals[hr]) : ensureInboxCols_(sh,hr);      // add PO/Signed PDF + Inbox columns if missing
  var iInv=col_(m,A.inv), iPoReq=col_(m,A.poReq), iPo=col_(m,A.po);
  var byInv={}, byPoReq={};
  for(var r=hr+1;r<vals.length;r++){
    var inv=String(iInv>=0?vals[r][iInv]:'').trim(); if(inv) byInv[inv.toLowerCase()]=r;
    var pr=String(iPoReq>=0?vals[r][iPoReq]:'').trim(); if(pr) byPoReq[pr.toLowerCase()]=r;
  }
  var seen=inboxSeen_(ss), root=DriveApp.getFolderById(DRIVE_ROOT), filed=[];
  var q='in:inbox has:attachment newer_than:'+INBOX.LOOKBACK_DAYS+'d (subject:"PO Request" OR subject:"Invoice" OR "EWS-POR" OR "EWSO-POR")';
  GmailApp.search(q,0,80).forEach(function(th){
    th.getMessages().forEach(function(msg){
      try{
        var id=msg.getId(); if(seen[id]) return;
        if(/revolution-es\.com/i.test(msg.getFrom()||'')) return;                 // skip our own sends
        var atts=msg.getAttachments().filter(function(a){ return /\.pdf$/i.test(a.getName())||a.getContentType()==='application/pdf'; });
        if(!atts.length) return;
        var subj=msg.getSubject()||'';
        var invM=subj.match(/\b(5[01]\d{3,})\b/), poM=subj.match(/EWSO?-POR-\S+/i);
        var kind=null, rowIdx=-1, docNo='';
        if(invM && byInv[invM[1].toLowerCase()]!=null){ kind='signed'; rowIdx=byInv[invM[1].toLowerCase()]; docNo=invM[1]; }
        else if(poM && byPoReq[poM[0].toLowerCase()]!=null){ kind='po'; rowIdx=byPoReq[poM[0].toLowerCase()]; docNo=poM[0]; }
        if(!kind || rowIdx<0) return;
        var year=String((msg.getDate()||new Date()).getFullYear());
        var folderName=(kind==='signed')?INBOX.SIGNED_FOLDER:INBOX.POASSIGNED_FOLDER;
        var rp={ operator:cellVal_(vals[rowIdx],m,A.operator), location:cellVal_(vals[rowIdx],m,A.location),
                 disc:cellVal_(vals[rowIdx],m,A.disc), unit:cellVal_(vals[rowIdx],m,A.unit),
                 inv:docNo, po:cellVal_(vals[rowIdx],m,A.po), poReq:docNo };     // fields from the matched tracker row
        var fname=pdfFileName_(rp,(kind==='signed')?'signed':'custpo');          // SIGNED - Invoice … / EWSO-PO-… scheme
        var uf=unitFolder_(rp.unit);
        if(preview){ filed.push(fname+'  →  '+folderName+' / '+year+(uf?' / '+uf:'')+'   (from '+String(msg.getFrom()).replace(/.*</,'').replace('>','')+')'); return; }
        var folder=folderChild_(folderChild_(root,folderName),year); if(uf) folder=folderChild_(folder,uf);   // …/<Year>/<unit>
        var ex=folder.getFilesByName(fname); while(ex.hasNext()) ex.next().setTrashed(true);
        var url=folder.createFile(atts[0].copyBlob().setName(fname)).getUrl();
        setCellByName_(sh,rowIdx,m,(kind==='signed')?A.sgnPdf:A.poPdf,url);
        setCellByName_(sh,rowIdx,m,A.inbox,(kind==='signed')?'Signed PDF received — confirm':'Customer PO received — confirm');
        inboxMarkSeen_(ss,id,fname);
        filed.push(fname+'  →  '+folderName+' / '+year);
      }catch(e){ /* skip a bad message, keep going */ }
    });
  });
  return (preview?'WOULD file ':'Filed ')+filed.length+' PDF(s)'+(filed.length?':\n • '+filed.join('\n • '):'.')+(preview?'\n\n(preview only — nothing written)':'');
}
function ensureInboxCols_(sh,hr){
  var need=[['po request pdf','PO Request PDF'],['invoice pdf','Invoice PDF'],['po assigned pdf','PO Assigned PDF'],['signed invoice pdf','Signed Invoice PDF'],['inbox','Inbox']];
  var hdrs=sh.getRange(hr+1,1,1,sh.getLastColumn()).getValues()[0].map(function(x){return String(x).trim().toLowerCase();});
  need.forEach(function(p){ if(hdrs.indexOf(p[0])<0){ sh.getRange(hr+1,sh.getLastColumn()+1).setValue(p[1]); } });
  return hdr_(sh.getRange(hr+1,1,1,sh.getLastColumn()).getValues()[0]);
}
function setCellByName_(sh,rowIdx,m,names,val){ var c=col_(m,names); if(c>=0 && val!==''&&val!=null) sh.getRange(rowIdx+1,c+1).setValue(val); }
function cellVal_(rowVals,m,names){ var c=col_(m,names); return c>=0?String(rowVals[c]==null?'':rowVals[c]):''; }
function inboxSeen_(ss){ var sh=ss.getSheetByName(INBOX.LOG_TAB), map={}; if(!sh||sh.getLastRow()<2) return map;
  sh.getRange(2,1,sh.getLastRow()-1,1).getValues().forEach(function(r){ if(r[0]) map[String(r[0])]=1; }); return map; }
function inboxMarkSeen_(ss,id,label){ var sh=ss.getSheetByName(INBOX.LOG_TAB);
  if(!sh){ sh=ss.insertSheet(INBOX.LOG_TAB); sh.getRange(1,1,1,3).setValues([['Message Id','Filed','When']]); sh.setFrozenRows(1); }
  sh.appendRow([id,label,new Date()]); }

/* Pull the invoice # out of a filename, ANCHORED on the word "Invoice"/"Inv" (or an explicit "EWS-#####")
   so a stray 5-digit number in the name (fleet #, customer PO #, a date, a $ amount) is never mistaken
   for the invoice number. Returns '' when the name carries no clearly-labelled invoice number. */
function invNumFromName_(name){
  var s=String(name||'');
  var m=s.match(/\bInv(?:oice)?\.?\s*#?\s*(?:EWS[-\s]*)?(\d{4,6})\b/i);   // "Invoice 50494", "Inv #50494", "Invoice EWS-50494"
  if(m) return m[1];
  m=s.match(/\bEWS[-\s]*(\d{4,6})\b/i);                                   // bare "EWS-50494" (POR #s never match: letters follow EWS-)
  return m?m[1]:'';
}
/* RE-RUNNABLE + AUTHORITATIVE: index the four EWS Billing folders (and their Year subfolders), match each
   PDF to a tracker row by the ID in its filename, and make each row's PDF columns EXACTLY reflect the
   files on Drive — it writes the matched link, and CLEARS a link that points at no matching file (so a
   stale/wrong link, e.g. a signed-invoice cell left pointing at another invoice, is removed). Pulls in
   files the system saved AND anything you filed by hand. Run it from the editor (Run ▸ linkDriveFiles)
   after adding PDFs. Matching: invoice folders need "Invoice <#####>" in the name (e.g. "Invoice 50494");
   PO folders need the PO Request # (EWS-POR-…) or the customer PO # (EWS-PO-…). It also flags duplicates
   (two files claiming the same row) so you can remove the extra copy. */
function linkDriveFiles(){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(WRITE_TAB);
  if(!sh) return 'Billing Tracker tab not found.';
  var hr=trackerHeaderRow_(sh.getRange(1,1,Math.min(sh.getLastRow(),15),sh.getLastColumn()).getValues()); if(hr<0) hr=0;
  var m=ensureInboxCols_(sh,hr);                                       // ensure the four PDF-link columns exist
  var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
  var iInv=col_(m,A.inv), iPoReq=col_(m,A.poReq), iPo=col_(m,A.po), byInv={}, byPoReq={}, byCustPo={};
  var norm_=function(s){ return String(s==null?'':s).toUpperCase().replace(/[^A-Z0-9]/g,''); };
  var digits_=function(s){ var d=String(s==null?'':s).match(/\d{4,6}/); return d?d[0]:''; };   // the invoice-# column holds a bare number
  for(var r=hr+1;r<vals.length;r++){
    var inv=digits_(iInv>=0?vals[r][iInv]:''); if(inv) byInv[inv]=r;          // key by digits so "EWS-50494" / "50494" both match
    var pr=norm_(iPoReq>=0?vals[r][iPoReq]:'').replace(/^EWSOPOR/,'EWSPOR'); if(pr) byPoReq[pr]=r;
    var cp=norm_(iPo>=0?vals[r][iPo]:'');                                     // customer PO # (e.g. EWSO-PO-2518)
    if(/^EWSO?PO\d+$/.test(cp)){ (byCustPo[cp]=byCustPo[cp]||[]).push(r); }   // one customer PO can cover several invoices
  }
  var root=DriveApp.getFolderById(DRIVE_ROOT), scanned=0, unmatched=[], dups=[];
  var jobs=[ {folder:'PO Requests',col:A.poReqPdf,key:'po'}, {folder:'Invoice Request',col:A.invPdf,key:'inv'},
             {folder:'PO Assigned',col:A.poPdf,key:'po'},  {folder:'Invoice Signed',col:A.sgnPdf,key:'inv'} ];
  var desired={}, managed={};                          // desired[colIdx][rowIdx]={url,name}; managed = columns whose folder we scanned
  jobs.forEach(function(job){
    var col=col_(m,job.col); if(col<0) return;
    var it=root.getFoldersByName(job.folder); if(!it.hasNext()) return;       // folder missing → do NOT touch this column
    managed[job.folder]=col; if(!desired[col]) desired[col]={};
    eachPdf_(it.next(),function(file){
      scanned++; var name=file.getName(), rows=[];
      if(job.key==='inv'){ var num=invNumFromName_(name); if(num && byInv[num]!=null) rows=[byInv[num]]; }
      else {
        var mp=name.match(/EWSO?-?POR-?\d+/i);                                // our PO Request # (EWS-POR-######)
        if(mp){ var k=norm_(mp[0]).replace(/^EWSOPOR/,'EWSPOR'); if(byPoReq[k]!=null) rows=[byPoReq[k]]; }
        if(!rows.length){ var mc=name.match(/EWSO?-?PO(?!R)-?\d+/i);          // else the customer PO # (EWS-PO-####) — links every invoice on that PO
          if(mc){ var kc=norm_(mc[0]); if(byCustPo[kc]) rows=byCustPo[kc]; } }
      }
      if(!rows.length){ if(unmatched.length<25) unmatched.push(job.folder+': '+name); return; }
      rows.forEach(function(rowIdx){
        var slot=desired[col][rowIdx];
        if(!slot){ desired[col][rowIdx]={url:file.getUrl(),name:name}; return; }
        if(slot.name===name) return;                                         // same file seen twice — ignore
        var a={url:file.getUrl(),name:name};                                 // two DIFFERENT files claim one row+column
        var keep=(name.localeCompare(slot.name)<0)?a:slot, drop=(keep===a)?slot:a;
        desired[col][rowIdx]=keep;
        if(dups.length<25) dups.push(job.folder+': "'+keep.name+'"  · also · "'+drop.name+'"');
      });
    });
  });
  // AUTHORITATIVE pass: for every data row × every managed column, set the matched link or CLEAR a stale Drive link.
  var linked=0, cleared=0;
  for(var rr=hr+1;rr<vals.length;rr++){
    for(var fn in managed){ var ci=managed[fn];
      var want=(desired[ci]&&desired[ci][rr])?desired[ci][rr].url:'';
      var cur=String(vals[rr][ci]||'');
      if(want){ if(cur!==want){ sh.getRange(rr+1,ci+1).setValue(want); vals[rr][ci]=want; linked++; } }
      else if(cur && /drive\.google\.com/i.test(cur)){ sh.getRange(rr+1,ci+1).setValue(''); vals[rr][ci]=''; cleared++; }
    }
  }
  var msg='Linked/updated '+linked+' link(s), cleared '+cleared+' stale link(s), from '+scanned+' PDF(s) across the four folders.';
  if(dups.length) msg+='\n\nDuplicate files — kept one, remove the extra:\n • '+dups.join('\n • ');
  if(unmatched.length) msg+='\n\nNo tracker match (check the ID in the filename):\n • '+unmatched.join('\n • ');
  return msg;
}
/* walk a folder + its immediate (Year) subfolders, calling cb for each PDF */
function eachPdf_(folder,cb){
  var f=folder.getFilesByType(MimeType.PDF); while(f.hasNext()) cb(f.next());
  var subs=folder.getFolders(); while(subs.hasNext()) eachPdf_(subs.next(),cb);   // recurse Year → 765/755 unit subfolders → any depth
}

/* ============================ #9 WORKBOOK OPTIMIZE (one-time, 2026-09-23) ============================
   1) Backs up the whole workbook (Drive copy) before touching anything.
   2) Billing Tracker: replaces the per-row formulas in Days Outstanding / Due Date / Aging Bucket with ONE
      ARRAYFORMULA in each header cell — only when every row has the same formula and it's array-safe.
      Afterwards it recomputes and compares every value to the old per-row results; any mismatch → that
      column is automatically put back exactly as it was.
   3) Deletes the unused "Billing Tracker (Clean)" tab — only if no formula anywhere refers to it.
   Run ▸ optimizeTrackerPreview first (changes nothing), then Run ▸ optimizeTracker. */
var OPT_COLS = [['days outstanding'],['due date'],['aging bucket']];
var OPT_DROP_TAB = 'Billing Tracker (Clean)';
var OPT_SAFE_FN = ['IF','IFS','IFERROR','IFNA','REGEXMATCH','REGEXEXTRACT','REGEXREPLACE','TODAY','VALUE','N','TEXT','DATEVALUE',
                   'ROUND','ROUNDUP','ROUNDDOWN','INT','ABS','LEN','TRIM','UPPER','LOWER','ISBLANK','ISNUMBER','ISTEXT','ISERROR','ARRAYFORMULA'];
function optimizeTrackerPreview(){ var r=optimizeTracker_(true); Logger.log(JSON.stringify(r,null,2)); return r; }
function optimizeTracker(){ var r=optimizeTracker_(false); Logger.log(JSON.stringify(r,null,2)); return r; }
function optArrayify_(f,colIdx1,firstRow){
  // f is an R1C1 formula like =IF(RC1="","",TODAY()-RC1). Every same-row ref becomes an A1 open range (A2:A).
  var body=f.replace(/^=/,''), parts=body.split(/("(?:[^"]|"")*")/), bad=null;
  for(var i=0;i<parts.length;i+=2){                                          // even parts are outside string literals
    var seg=parts[i];
    if(/!/.test(seg)) { bad='references another tab'; break; }
    (seg.match(/\b([A-Z][A-Z0-9\.]*)\s*\(/g)||[]).forEach(function(fn){ fn=fn.replace(/\s*\($/,''); if(OPT_SAFE_FN.indexOf(fn)<0) bad=bad||('uses '+fn+'() which is not array-safe'); });
    parts[i]=seg.replace(/(^|[^A-Za-z0-9_])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Za-z0-9_\[])/g,function(m,pre,r,c){
      if(r && r!=='[0]') { bad=bad||'refers to a different row'; return m; }
      var col = !c ? colIdx1 : (c.charAt(0)==='[' ? colIdx1+Number(c.slice(1,-1)) : Number(c));
      var L=colLetter_(col-1); return pre+L+firstRow+':'+L;                    // same-row ref → open column range (A1)
    });
  }
  return bad ? {ok:false, why:bad} : {ok:true, body:parts.join('')};
}
function optimizeTracker_(preview){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(WRITE_TAB), out={preview:!!preview, columns:[], dropTab:null};
  var h=hdrInfo_(sh); if(!h) return {error:'Billing Tracker header row not found'};
  var first=h.hr+2, maxR=sh.getMaxRows(), n=maxR-first+1;
  if(!preview){ out.backup=DriveApp.getFileById(BOOK_ID).makeCopy('EWS Billing Tracker — backup before optimize '+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm')).getUrl(); }
  OPT_COLS.forEach(function(names){
    var ci=col_(h.m,names), rep={column:names[0]};
    if(ci<0){ rep.skip='column not found'; out.columns.push(rep); return; }
    var hdrCell=sh.getRange(h.hr+1,ci+1); rep.cell=colLetter_(ci)+(h.hr+1);
    if(/ARRAYFORMULA/i.test(hdrCell.getFormula())){ rep.skip='already an array formula'; out.columns.push(rep); return; }
    var rg=sh.getRange(first,ci+1,n,1), fR1=rg.getFormulasR1C1().map(function(r){return r[0];}), vals=rg.getValues().map(function(r){return r[0];});
    var distinct={}, consts=0, rowsWithF=0;
    fR1.forEach(function(f,i){ if(f){ distinct[f]=(distinct[f]||0)+1; rowsWithF++; } else if(String(vals[i])!=='') consts++; });
    var keys=Object.keys(distinct); rep.rowsWithFormula=rowsWithF; rep.distinctFormulas=keys.length; rep.typedValues=consts;
    if(keys.length!==1){ rep.skip=keys.length?'rows use different formulas':'no formulas'; rep.samples=keys.slice(0,3); out.columns.push(rep); return; }
    if(consts>0){ rep.skip=consts+' row(s) have typed values instead of the formula — left alone so nothing is overwritten'; out.columns.push(rep); return; }
    var conv=optArrayify_(keys[0],ci+1,first);
    rep.oldFormulaR1C1=keys[0];
    if(!conv.ok){ rep.skip=conv.why; out.columns.push(rep); return; }
    var hdrText=String(hdrCell.getValue()), header=hdrText.replace(/"/g,'""');
    rep.newFormula='={"'+header+'";ARRAYFORMULA('+conv.body+')}';
    if(preview){ rep.action='would convert'; out.columns.push(rep); return; }
    // apply → verify → auto-revert on any mismatch
    var before=rg.getDisplayValues().map(function(r){return r[0];});
    rg.clearContent(); hdrCell.setFormula(rep.newFormula); SpreadsheetApp.flush();
    var after=rg.getDisplayValues().map(function(r){return r[0];}), bad=0, badRows=[];
    for(var i=0;i<n;i++){ if(fR1[i] && before[i]!==after[i]){ bad++; if(badRows.length<5) badRows.push((first+i)+': '+before[i]+' → '+after[i]); } }
    if(bad){ hdrCell.setValue(hdrText); rg.setFormulasR1C1(fR1.map(function(f){return [f];})); SpreadsheetApp.flush();   // exact restore
      rep.action='REVERTED — '+bad+' value(s) differed'; rep.mismatches=badRows; }
    else rep.action='converted — all '+rowsWithF+' values identical';
    out.columns.push(rep);
  });
  // drop the unused copy tab, only if nothing points at it
  var drop=ss.getSheetByName(OPT_DROP_TAB);
  if(!drop) out.dropTab={tab:OPT_DROP_TAB, skip:'not found'};
  else {
    var refs=0; ss.getSheets().forEach(function(s2){ if(s2.getName()===OPT_DROP_TAB) return; var lr=s2.getLastRow(), lc=s2.getLastColumn(); if(lr<1||lc<1) return;
      s2.getRange(1,1,lr,lc).getFormulas().forEach(function(r){ r.forEach(function(x){ if(x && x.indexOf(OPT_DROP_TAB)>=0) refs++; }); }); });
    if(refs) out.dropTab={tab:OPT_DROP_TAB, skip:refs+' formula(s) refer to it — kept'};
    else if(preview) out.dropTab={tab:OPT_DROP_TAB, action:'would delete (nothing refers to it)'};
    else { ss.deleteSheet(drop); out.dropTab={tab:OPT_DROP_TAB, action:'deleted'}; }
  }
  if(!preview) bustCache_();
  return out;
}

/* ---- #9 follow-up (2026-09-23): verify against the backup + repair Due Date (column Q) ---- */
function optBackupSS_(){
  var it=DriveApp.searchFiles('title contains "EWS Billing Tracker — backup before optimize" and trashed=false'), best=null;
  while(it.hasNext()){ var f=it.next(); if(!best||f.getDateCreated()>best.getDateCreated()) best=f; }
  return best ? {file:best, ss:SpreadsheetApp.openById(best.getId())} : null;
}
/* Read-only: compare Days Outstanding / Due Date / Aging Bucket, row by row, with the backup taken before optimizing. */
function verifyOptimize_(){
  var b=optBackupSS_(); if(!b) return {error:'backup not found'};
  var cur=SpreadsheetApp.openById(BOOK_ID).getSheetByName(WRITE_TAB), old=b.ss.getSheetByName(WRITE_TAB);
  var h=hdrInfo_(cur), first=h.hr+2, last=Math.max(old.getLastRow(),first), n=last-first+1, out={backup:b.file.getName(), rows:n, columns:[]};
  OPT_COLS.forEach(function(names){
    var ci=col_(h.m,names); if(ci<0) return;
    var a=old.getRange(first,ci+1,n,1).getDisplayValues(), c=cur.getRange(first,ci+1,n,1).getDisplayValues(), f=cur.getRange(first,ci+1,Math.min(3,n),1).getFormulas();
    var bad=[], cnt=0; for(var i=0;i<n;i++){ if(a[i][0]!==c[i][0]){ cnt++; if(bad.length<6) bad.push((first+i)+': was "'+a[i][0]+'" now "'+c[i][0]+'"'); } }
    out.columns.push({column:names[0], header:cur.getRange(h.hr+1,ci+1).getFormula()||cur.getRange(h.hr+1,ci+1).getValue(), row2Formula:f[0][0], mismatches:cnt, samples:bad});
  });
  return out;
}
/* Put Due Date back to its original per-row formula on every data row (and clear the empty rows below), then verify. */
function repairDueDate(){
  var sh=SpreadsheetApp.openById(BOOK_ID).getSheetByName(WRITE_TAB), h=hdrInfo_(sh), ci=col_(h.m,['due date']);
  var A=colLetter_(col_(h.m,A_.date)), P=colLetter_(col_(h.m,['payment terms'])), first=h.hr+2, maxR=sh.getMaxRows();
  var lastData=first-1, keys=keyCol_(sh,h.hr,col_(h.m,A_.date)); for(var i=keys.length-1;i>=0;i--){ if(keys[i]!==''){ lastData=first+i; break; } }
  var hdr=sh.getRange(h.hr+1,ci+1); if(/ARRAYFORMULA/i.test(hdr.getFormula())) hdr.setValue('Due Date');
  sh.getRange(first,ci+1,maxR-first+1,1).clearContent();
  var fs=[]; for(var r=first;r<=Math.max(lastData,first);r++) fs.push(['=IF($'+A+r+'="","",$'+A+r+'+IFERROR(VALUE(REGEXEXTRACT($'+P+r+'&"","\\d+")),60))']);
  sh.getRange(first,ci+1,fs.length,1).setFormulas(fs);
  SpreadsheetApp.flush(); bustCache_();
  var v=verifyOptimize_(); Logger.log(JSON.stringify(v,null,2)); return v;
}
var A_ = { date:['invoice date','date','billing date'] };
