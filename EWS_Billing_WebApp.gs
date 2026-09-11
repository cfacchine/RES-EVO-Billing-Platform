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
var DRIVE_ROOT = '1uMR9dqS52Z4ZqUAqmIaLzUqLhpmmtAZY';           // shared "EWS Billing" folder — PDFs saved here (Unit/Year/Month/Type)

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
  invPdf:['invoice pdf','invoice pdf link']
};

function doGet(e){
  var a=(e&&e.parameter&&e.parameter.action)||'summary';
  if(a==='schedule')  return json_(getSchedule_());
  if(a==='directory') return json_(getDirectory_());
  if(a==='lists')     return json_(getLists_());
  if(a==='emails')    return json_(getEmails_());
  if(a==='inspect')   return json_(inspect_());
  if(a==='logins')    return json_(getLogins_(e));
  return json_(getSummary_());
}
function doPost(e){
  try{ var body=JSON.parse(e.postData.contents); var lock=LockService.getScriptLock(); lock.tryLock(20000);
    try{ if(body.action==='po'||body.action==='invoice') return json_({ok:true,row:appendDoc_(body.payload||{},body.action)});
         if(body.action==='logLogin') return json_({ok:true,row:logLogin_(body.payload||{})});
         if(body.action==='save') return json_({ok:true,row:saveDoc_(body.payload||{})});
         if(body.action==='update') return json_({ok:updateRow_(body.payload||{})});
         if(body.action==='delete') return json_({ok:deleteDoc_(body.payload||{})});
         if(body.action==='tidy' && body.payload && body.payload.confirm==='TIDY') return json_({ok:true,msg:tidyBillingTracker_(false)});
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
    for(var r=hr+1;r<vals.length;r++){ var v=vals[r], inv=g_(v,ci.inv), amt=g_(v,ci.amount), poReq=g_(v,ci.poReq);
      if(!inv && !amt && !poReq) continue;
      var status=String(g_(v,ci.status)||'');
      var paid = (paid_(g_(v,ci.paid))==='Yes' || /paid|collected/i.test(status)) ? 'Yes':'No';
      var pk = parsePack_(g_(v,ci.lines));
      out.push({ inv:String(inv||'').trim(), date:fmtDate_(g_(v,ci.date)), amount:Number(amt)||0,
        start:pk.start||'', end:pk.end||'',
        signed:x_(g_(v,ci.signed)), poReq:String(poReq||''), poAssigned: g_(v,ci.po)?'Yes':x_(g_(v,ci.poAssigned)),
        reminderSent:x_(g_(v,ci.reminder)), paid:paid, invoiceStatus:status,
        unit:unitText_(g_(v,ci.unit), inv), po:String(g_(v,ci.po)||''),
        operator:String(g_(v,ci.operator)||''), location:String(g_(v,ci.location)||''), disc:String(g_(v,ci.disc)||''),
        fleet:String(g_(v,ci.fleet)||''),
        contactName:String(g_(v,ci.cName)||''), contactEmail:String(g_(v,ci.cEmail)||''), contactPhone:String(g_(v,ci.cPhone)||''),
        terms:String(g_(v,ci.terms)||''), paidDate:fmtDate_(g_(v,ci.paidDate)), sentDate:fmtDate_(g_(v,ci.sentDate)),
        pdfUrl:String(g_(v,ci.invPdf)||g_(v,ci.poReqPdf)||''),
        lineItems:pk.lines, notes:(pk.notes || String(g_(v,ci.notes)||'')),
        _tab:name }); }
  });
  return { rows:out };
}
function mapCols_(m){
  var ci={}; Object.keys(A).forEach(function(k){ ci[k]=col_(m,A[k]); });
  ci.poAssigned=col_(m,['po assigned']);
  return ci;
}
function unitText_(u,inv){ var s=String(u||''); if(/765/.test(s)) return '765'; if(/755/.test(s)) return '755';
  var iv=String(inv||'').trim(); if(iv.charAt(0)==='5'&&iv.charAt(1)==='1') return '755'; if(iv.charAt(0)==='5'&&iv.charAt(1)==='0') return '765'; return '755'; }

/* ============================ INSPECT (verification) ============================ */
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
function savePdf_(p,action){
  if(!p.pdfB64) return '';
  try{
    var root=DriveApp.getFolderById(DRIVE_ROOT);
    var unit=(String(p.unit)==='765')?'765 Operations':'755 Equipment Service';
    var d=p.date?new Date(p.date):new Date(); if(isNaN(d.getTime())) d=new Date();
    var mon=('0'+(d.getMonth()+1)).slice(-2)+'-'+MONTHS_[d.getMonth()];
    var type=(action==='invoice')?'Invoices':'PO Requests';
    var folder=folderChild_(folderChild_(folderChild_(folderChild_(root,unit),String(d.getFullYear())),mon),type);
    var num=(action==='invoice')?(p.inv||p.poReq||'doc'):(p.poReq||'doc');
    var fname=((action==='invoice')?'Invoice_':'PO_Request_')+num+'.pdf';
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
    var found=findRowByPoReq_(ss,p.poReq);
    if(found){ var fm=ensureLineItemsCol_(found.sh,found.hr);
      setCell_(found.sh,found.row,fm,A.inv,p.inv);
      setCell_(found.sh,found.row,fm,A.amount,amount);
      setCell_(found.sh,found.row,fm,A.po,p.po);
      setCell_(found.sh,found.row,fm,A.lines,linesJson);
      setCell_(found.sh,found.row,fm,A.notes,p.notes);
      setCell_(found.sh,found.row,fm,A.fleet,p.fleet);
      setCell_(found.sh,found.row,fm,A.cEmail,p.contactEmail);
      setCell_(found.sh,found.row,fm,A.invPdf,pdfOk);
      setCell_(found.sh,found.row,fm,A.status,'Invoiced');
      return found.row;
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
  function setC(names,val){ var i=col_(m,names); if(i>=0 && val!==''&&val!=null) sh.getRange(target,i+1).setValue(val); }
  setC(A.inv,p.inv); setC(A.date, safeDate_(p.date)); setC(A.amount,amount);
  setC(A.unit, p.unit==='765'?'Evolution Well Service Operating (765)':'Evolution Well Services (755)');
  setC(A.operator,p.operator); setC(A.location,p.location); setC(A.disc,p.disc); setC(A.fleet,p.fleet);
  setC(A.poReq,p.poReq); setC(A.po,p.po); setC(A.lines,linesJson);
  setC(A.cName,p.contactName||p.contact); setC(A.cEmail,p.contactEmail); setC(A.cPhone,p.contactPhone);
  setC(action==='invoice'?A.invPdf:A.poReqPdf, pdfOk);
  setC(A.status, action==='invoice'?'Invoiced':'Requested');
  setC(A.notes, p.notes || [p.operator,p.location,p.disc].filter(Boolean).join(' - '));
  return target;
}
function safeDate_(v){ var d = v ? new Date(v) : new Date(); if(isNaN(d.getTime()) || d.getFullYear()<2020 || d.getFullYear()>2100) d=new Date(); return d; }

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
  var ss=SpreadsheetApp.openById(BOOK_ID), done=false;
  var isPaid=p.field==='paid';
  var target = p.field==='signed'?A.signed : p.field==='poAssigned'?['po assigned'] : isPaid?A.paid : A.reminder;
  var mark=(String(p.value).toLowerCase().charAt(0)==='y')?'Yes':'No';
  TRK_TABS.forEach(function(name){ if(done) return; var sh=ss.getSheetByName(name); if(!sh||sh.getLastRow()<2) return;
    var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues(); var hr=trackerHeaderRow_(vals); if(hr<0) return;
    var m=hdr_(vals[hr]); var iInv=col_(m,A.inv), iCol=col_(m,target); if(iInv<0) return;
    for(var r=hr+1;r<vals.length;r++){
      if(p.inv && String(vals[r][iInv]).trim()===String(p.inv).trim()){
        if(iCol>=0) sh.getRange(r+1,iCol+1).setValue(mark==='Yes'?(isPaid?'Yes':'X'):'');
        if(isPaid){ var iSt=col_(m,A.status);
          if(iSt>=0){ var cur=String(vals[r][iSt]||'').trim();
            if(mark==='Yes') sh.getRange(r+1,iSt+1).setValue('Paid');
            else if(/^paid$/i.test(cur)) sh.getRange(r+1,iSt+1).setValue(''); } }
        done=true; return;
      }
    }
  });
  return done;
}

/* Delete a single erroneous entry — only from the current Billing Tracker tab (history is never touched). */
function deleteDoc_(p){
  var ss=SpreadsheetApp.openById(BOOK_ID), sh=ss.getSheetByName(WRITE_TAB); if(!sh||sh.getLastRow()<2) return false;
  var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues();
  var hr=trackerHeaderRow_(vals); if(hr<0) return false;
  var m=hdr_(vals[hr]), iInv=col_(m,A.inv), iPo=col_(m,A.poReq);
  var inv=String(p.inv||'').trim().toLowerCase(), poReq=String(p.poReq||'').trim().toLowerCase();
  if(!inv && !poReq) return false;
  for(var r=hr+1;r<vals.length;r++){
    var rInv=iInv>=0?String(vals[r][iInv]||'').trim().toLowerCase():'';
    var rPo =iPo>=0?String(vals[r][iPo]||'').trim().toLowerCase():'';
    var ok=(inv? rInv===inv : true) && (poReq? rPo===poReq : true) && ((inv&&rInv===inv)||(poReq&&rPo===poReq));
    if(ok){ sh.deleteRow(r+1); return true; }
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
function findRowByPoReq_(ss,poReq){
  var res=null, q=String(poReq).trim().toLowerCase();
  TRK_TABS.forEach(function(name){ if(res) return; var sh=ss.getSheetByName(name); if(!sh||sh.getLastRow()<2) return;
    var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues(); var hr=trackerHeaderRow_(vals); if(hr<0) return;
    var m=hdr_(vals[hr]); var iP=col_(m,A.poReq); if(iP<0) return;
    for(var r=hr+1;r<vals.length;r++){ if(String(vals[r][iP]).trim().toLowerCase()===q){ res={sh:sh,row:r+1,hr:hr}; return; } }
  }); return res;
}
function setCell_(sh,row,m,names,val){ var i=col_(m,names); if(i>=0 && val!==''&&val!=null) sh.getRange(row,i+1).setValue(val); }
function findRowByInv_(ss,inv){
  var res=null, q=String(inv).trim().toLowerCase();
  TRK_TABS.forEach(function(name){ if(res) return; var sh=ss.getSheetByName(name); if(!sh||sh.getLastRow()<2) return;
    var vals=sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues(); var hr=trackerHeaderRow_(vals); if(hr<0) return;
    var m=hdr_(vals[hr]); var iI=col_(m,A.inv); if(iI<0) return;
    for(var r=hr+1;r<vals.length;r++){ if(String(vals[r][iI]).trim().toLowerCase()===q){ res={sh:sh,row:r+1,hr:hr}; return; } }
  }); return res;
}
/* Upsert a document by PO Request # (or Invoice #) — update the row in place if it exists, else write a new one. Never duplicates. */
function saveDoc_(p){
  var ss=SpreadsheetApp.openById(BOOK_ID);
  var amount=p.total!=null?Number(p.total):(p.lines||[]).reduce(function(a,l){return a+(Number(l.total)||0);},0);
  var linesJson=JSON.stringify({start:p.start||'', end:p.end||'', notes:p.notes||'', lines:(p.rawLines||p.lines||[])});
  var found = p.poReq ? findRowByPoReq_(ss,p.poReq) : null;
  if(!found && p.inv) found = findRowByInv_(ss,p.inv);
  if(found){
    var fm=ensureLineItemsCol_(found.sh,found.hr);
    setCell_(found.sh,found.row,fm,A.inv,p.inv);
    setCell_(found.sh,found.row,fm,A.poReq,p.poReq);
    setCell_(found.sh,found.row,fm,A.po,p.po);
    setCell_(found.sh,found.row,fm,A.amount,amount);
    setCell_(found.sh,found.row,fm,A.operator,p.operator);
    setCell_(found.sh,found.row,fm,A.location,p.location);
    setCell_(found.sh,found.row,fm,A.disc,p.disc);
    setCell_(found.sh,found.row,fm,A.fleet,p.fleet);
    setCell_(found.sh,found.row,fm,A.date,safeDate_(p.date));
    setCell_(found.sh,found.row,fm,A.lines,linesJson);
    setCell_(found.sh,found.row,fm,A.notes,p.notes);
    setCell_(found.sh,found.row,fm,A.cName,p.contactName||p.contact);
    setCell_(found.sh,found.row,fm,A.cEmail,p.contactEmail);
    setCell_(found.sh,found.row,fm,A.cPhone,p.contactPhone);
    setCell_(found.sh,found.row,fm,A.status, p.inv?'Invoiced':'Requested');
    return found.row;
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
function fmtDate_(d){ if(d instanceof Date) return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd'); return d?String(d):''; }
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
    var pdf=apFetchPdf_(x.pdfUrl); if(pdf) opts.attachments=[pdf];
    if(AUTOPILOT.MODE==='send') GmailApp.sendEmail(to,subj,body,opts); else GmailApp.createDraft(to,subj,body,opts);
    updateRow_({inv:x.inv, poReq:x.poReq, field:'reminder', value:'Yes'});
    return true;
  }catch(e){ return false; }
}
function apFetchPdf_(url){ try{ if(!url) return null; var m=String(url).match(/[-\w]{25,}/); return m?DriveApp.getFileById(m[0]).getBlob():null; }catch(e){ return null; } }

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
