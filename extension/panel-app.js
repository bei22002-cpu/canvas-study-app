// ── STATE ──────────────────────────────────────────────────────────────────
const PROXY='http://127.0.0.1:3001';
const STORE_KEY='canvasStudyApp_v2';
const COLORS=['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6','#6366f1','#a855f7','#e11d48','#0891b2','#65a30d'];

let canvasDomain='',canvasToken='',anthropicKey='';
let courses=[],allAssignments=[],courseData={};
let activeCourse=null,chatHistory=[],isLoading=false;
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth(),calView='month';
let visibleCourseIds=new Set(),courseColors={},currentEvent=null;
const ANTHROPIC_MODEL='claude-sonnet-4-20250514';
const WEB_TOOL_DEF={type:'web_search_20250305',name:'web_search'};
const LIB_DB_NAME='canvasLibrary_v1';
const LIB_STORE='items';
let matFilter='all',activeMatCourse=null,materialsList=[],materialsModules=[];
let viewerCtx=null,viewerLoad=null;
let tutorChatHistory=[],lastReplySources=[],isTutorLoading=false;
let libDbPromise=null;

// ── STORAGE (extension: background proxy + chrome.storage.local) ───────────
async function saveCredentials(opts={}){
  const remember=document.getElementById('rememberMe')?.checked!==false;
  if(!remember&&!opts.force)return;
  const payload={
    canvasDomain,canvasToken,anthropicKey,courseColors,
    rememberMe:true,lastConnectedAt:Date.now()
  };
  if(window.__CS_EXT__){
    try{await extSaveLogin(payload);}catch(e){}
    return;
  }
  try{localStorage.setItem(STORE_KEY,JSON.stringify({domain:canvasDomain,token:canvasToken,anthropicKey,courseColors}));}catch(e){}
}
async function loadCredentials(){
  if(window.__CS_EXT__){
    try{
      const r=await extLoadLogin();
      if(r.canvasDomain||r.canvasToken){
        return{
          domain:r.canvasDomain,token:r.canvasToken,
          anthropicKey:r.anthropicKey,courseColors:r.courseColors,
          rememberMe:r.rememberMe!==false
        };
      }
    }catch(e){}
    return null;
  }
  try{const r=localStorage.getItem(STORE_KEY);return r?JSON.parse(r):null;}catch(e){return null;}
}
async function clearSaved(){
  if(window.__CS_EXT__){
    try{await extClearLogin();}catch(e){}
  }else localStorage.removeItem(STORE_KEY);
  location.reload();
}
function getUrlDomainParam(){
  try{return new URLSearchParams(location.search).get('domain')||'';}catch(e){return '';}
}

// ── INIT ───────────────────────────────────────────────────────────────────
window.addEventListener('load',async()=>{
  if(window.__CS_EXT__){
    document.documentElement.classList.add('cs-ext-panel');
    const hint=document.getElementById('credStorageHint');
    if(hint)hint.textContent='Saved by the extension background proxy (chrome.storage.local)';
  }
  const urlDomain=getUrlDomainParam();
  if(urlDomain){
    const domEl=document.getElementById('domain');
    if(!domEl.value)domEl.value=normalizeCanvasDomain(urlDomain);
    domEl.title='Auto-detected from this Canvas tab — edit if Connect fails';
  }
  const saved=await loadCredentials();
  if(saved?.rememberMe!==false)document.getElementById('rememberMe').checked=true;
  if(saved?.domain&&saved?.token){
    document.getElementById('savedBadge').style.display='flex';
    if(!urlDomain)document.getElementById('domain').value=saved.domain;
    document.getElementById('token').value=saved.token;
    if(saved.anthropicKey)document.getElementById('anthropicKey').value=saved.anthropicKey;
    if(saved.courseColors)courseColors=saved.courseColors;
    canvasDomain=saved.domain;canvasToken=saved.token;anthropicKey=saved.anthropicKey||'';
    setTimeout(()=>connect(true),500);
  }
  checkProxy();
  attachCanvasSmartLinks('messages');
  attachCanvasSmartLinks('tutorMessages');
});

async function checkProxy(){
  const el=document.getElementById('proxyStatus');if(!el)return;
  if(window.__CS_EXT__){
    try{
      const r=await extSendMessage({type:'PROXY_HEALTH'});
      if(r?.ok){el.textContent='Background proxy ready';el.style.color='var(--green)';}
      else throw new Error('no');
    }catch(e){
      el.textContent='Background proxy offline — reload extension';
      el.style.color='var(--rust)';
    }
    return;
  }
  try{
    const r=await fetch(PROXY+'/proxy-health',{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    await r.json().catch(()=>({}));
    el.textContent='✓ Running';
    el.style.color='var(--green)';
  }catch(e){
    el.textContent='Not running';
    el.style.color='var(--rust)';
  }
}

// ── NAV ────────────────────────────────────────────────────────────────────
function showPage(pageId,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  if(btn)btn.classList.add('active');
}

// ── CANVAS API (extension → background proxy; standalone → python proxy) ───
async function proxyGet(path){
  if(window.__CS_EXT__){
    const r=await extProxyRequest(path,{domain:canvasDomain,token:canvasToken});
    return r.json;
  }
  const r=await fetch(PROXY+path,{headers:{'Authorization':`Bearer ${canvasToken}`,'X-Canvas-Domain':canvasDomain}});
  if(!r.ok)throw new Error(`Canvas ${r.status}`);
  return r.json();
}
function parseLinkNext(linkHeader){
  if(!linkHeader)return null;
  const parts=linkHeader.split(',');
  for(const raw of parts){
    const m=raw.trim().match(/<([^>]+)>;\s*rel="next"/i);
    if(m){
      try{const u=new URL(m[1]);return u.pathname+u.search;}catch(e){return null;}
    }
  }
  return null;
}
async function proxyGetAll(path,maxPages=25){
  let next=path;
  const out=[];
  let guard=0;
  while(next&&guard++<maxPages){
    let chunk,link;
    if(window.__CS_EXT__){
      const r=await extProxyRequest(next,{domain:canvasDomain,token:canvasToken});
      chunk=r.json;
      link=r.link||'';
    }else{
      const r=await fetch(PROXY+next,{headers:{'Authorization':`Bearer ${canvasToken}`,'X-Canvas-Domain':canvasDomain}});
      if(!r.ok)throw new Error(`Canvas ${r.status}`);
      chunk=await r.json();
      link=r.headers.get('Link')||'';
    }
    next=parseLinkNext(link);
    if(Array.isArray(chunk))out.push(...chunk);
    else return chunk;
  }
  return out;
}

async function fetchActiveCourses(){
  const paths=[
    '/api/v1/courses?enrollment_state=active&per_page=30&include[]=total_scores',
    '/api/v1/courses?enrollment_state=active&per_page=30'
  ];
  for(const p of paths){
    try{
      const data=await proxyGet(p);
      if(Array.isArray(data))return data;
    }catch(e){if(p===paths[paths.length-1])throw e;}
  }
  throw new Error('Canvas returned an unexpected response. Check domain and token.');
}

async function connect(silent=false){
  const domain=normalizeCanvasDomain(document.getElementById('domain').value);
  const token=normalizeCanvasToken(document.getElementById('token').value);
  const aKey=document.getElementById('anthropicKey').value.trim();
  document.getElementById('domain').value=domain;
  document.getElementById('token').value=token;
  document.getElementById('errMsg').style.display='none';
  if(!domain||!token){
    if(!silent)showErr('Canvas domain and access token are required.');
    return;
  }
  canvasDomain=domain;
  canvasToken=token;
  anthropicKey=aKey;
  const btn=document.getElementById('connectBtn');
  btn.disabled=true;
  btn.textContent='Connecting…';
  document.getElementById('dot').className='status-dot loading';
  try{
    await saveCredentials({force:true});
    btn.textContent='Verifying Canvas…';
    const self=await proxyGet('/api/v1/users/self');
    if(!self?.id)throw new Error('Canvas login failed — no user profile returned.');
    btn.textContent='Loading courses…';
    const fetchedCourses=await fetchActiveCourses();
    courses=fetchedCourses.filter(c=>c.name&&!c.access_restricted_by_date);
    courses.forEach((c,i)=>{if(!courseColors[c.id])courseColors[c.id]=COLORS[i%COLORS.length];});
    visibleCourseIds=new Set(courses.map(c=>c.id));
    buildUI(self);
    buildCalendar();
    buildSettings(self);
    btn.disabled=false;
    btn.textContent='Connected';
    if(!aKey&&!silent){
      showErr('Connected to Canvas. Add an Anthropic API key above to use AI chat and tutor.');
      document.getElementById('errMsg').style.color='#92400e';
      document.getElementById('errMsg').style.background='#fffbeb';
    }
    loadAllAssignments().catch(()=>{});
  }catch(e){
    let msg=e.message||String(e);
    if(/fetch|Failed|NetworkError|network/i.test(msg)){
      msg=window.__CS_EXT__
        ?'Could not reach Canvas. Confirm domain (e.g. yourschool.instructure.com), create a new access token, and reload the extension.'
        :('Cannot reach proxy at '+PROXY+'. Run: python canvas-proxy.py');
    }
    showErr(msg);
    document.getElementById('errMsg').style.color='';
    document.getElementById('errMsg').style.background='';
    btn.disabled=false;
    btn.textContent='Connect to Canvas';
    document.getElementById('dot').className='status-dot off';
    document.getElementById('savedBadge').style.display='none';
  }
}

async function loadAllAssignments(){
  allAssignments=[];
  await Promise.all(courses.slice(0,20).map(async c=>{
    try{
      const data=await proxyGetAll(`/api/v1/courses/${c.id}/assignments?per_page=100&order_by=due_at&include[]=submission`,20);
      const arr=Array.isArray(data)?data:[];
      arr.forEach(a=>{
        allAssignments.push({
          ...a,course_name:c.name,course_code:c.course_code||'',course_id:c.id,
          color:courseColors[c.id]||'#3b82f6',
          quiz_id:a.quiz_id,submission_types:a.submission_types,
          html_url:a.html_url||`https://${canvasDomain}/courses/${c.id}/assignments/${a.id}`
        });
      });
      courseData[c.id]={assignments:arr};
    }catch(e){courseData[c.id]={assignments:[]};}
  }));
}

function buildUI(self){
  document.getElementById('setupPage').classList.remove('active');
  document.getElementById('chatPage').classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.nav-tab')[0].classList.add('active');
  document.getElementById('dot').className='status-dot';
  const chip=document.getElementById('userChip');
  chip.style.display='block';chip.textContent=self.name.split(' ')[0];
  document.getElementById('infoBar').style.display='block';
  document.getElementById('infoBar').innerHTML=`Connected as <span>${self.name}</span> · <span>${courses.length}</span> courses · <span>${allAssignments.filter(a=>a.due_at).length}</span> assignments with due dates`;
  buildCourseSidebar();
  populateTutorAndLibraryUI();
  openLibraryDb().then(()=>refreshLibraryList()).catch(()=>{});
}

function buildCourseSidebar(){
  const list=document.getElementById('courseList');
  list.innerHTML='';
  const allEl=document.createElement('div');
  allEl.className='course-item active';
  allEl.innerHTML=`<div class="course-dot" style="background:var(--navy)"></div><div><div class="cname">All Courses</div></div>`;
  allEl.data-cs-onclick=()=>selectCourse(null,allEl);
  list.appendChild(allEl);
  courses.forEach(c=>{
    const el=document.createElement('div');
    el.className='course-item';
    el.setAttribute('data-course-id',c.id);
    el.innerHTML=`<div class="course-dot" style="background:${courseColors[c.id]}"></div><div><div class="cname">${c.name}</div><div class="ccode">${c.course_code||''}</div></div>`;
    el.data-cs-onclick=()=>selectCourse(c,el);
    list.appendChild(el);
  });
}

function fillCourseDropdown(selectEl,withAllOption){
  if(!selectEl)return;
  const cur=selectEl.value;
  selectEl.innerHTML='';
  if(withAllOption){
    const o=document.createElement('option');o.value='';o.textContent='All my courses';selectEl.appendChild(o);
  }
  courses.forEach(c=>{
    const o=document.createElement('option');
    o.value=String(c.id);
    o.textContent=c.course_code?`${c.course_code} — ${c.name}`:c.name;
    selectEl.appendChild(o);
  });
  if(cur&&[...selectEl.options].some(x=>x.value===cur))selectEl.value=cur;
}

function populateTutorAndLibraryUI(){
  fillCourseDropdown(document.getElementById('tutorCourseFocus'),true);
  fillCourseDropdown(document.getElementById('libCourseFilter'),true);
  fillCourseDropdown(document.getElementById('tbCourse'),false);
  restoreTutorPrefs();
}

function selectCourse(course,el){
  activeCourse=course;
  document.querySelectorAll('#courseList .course-item').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('bannerName').textContent=course?course.name:'All Courses';
  document.getElementById('bannerCode').textContent=course?(course.course_code||''):'Ask anything about your enrolled courses';
}

// ── CALENDAR ───────────────────────────────────────────────────────────────
function buildCalendar(){buildCalFilters();renderCal();}

function buildCalFilters(){
  const el=document.getElementById('calCourseFilters');
  el.innerHTML='';
  courses.forEach(c=>{
    const row=document.createElement('div');
    row.className='cal-course-row';
    row.innerHTML=`
      <input type="checkbox" id="cf-${c.id}" checked data-cs-onchange="toggleCourse(${c.id},this.checked)"/>
      <div class="color-swatch" style="background:${courseColors[c.id]}" title="Click to change color">
        <input type="color" value="${courseColors[c.id]}" data-cs-onchange="changeCourseColor(${c.id},this.value)"/>
      </div>
      <label class="cal-course-label" for="cf-${c.id}" title="${c.name}">${c.course_code||c.name}</label>`;
    el.appendChild(row);
  });
}

function toggleCourse(id,checked){
  if(checked)visibleCourseIds.add(id);else visibleCourseIds.delete(id);
  renderCal();
}

function changeCourseColor(id,color){
  courseColors[id]=color;
  // Update all assignment colors
  allAssignments.forEach(a=>{if(a.course_id===id)a.color=color;});
  saveCredentials();
  buildCalFilters();
  buildSettings();
  renderCal();
  // Update sidebar dots
  document.querySelectorAll(`#courseList .course-item[data-course-id="${id}"] .course-dot`).forEach(d=>d.style.background=color);
  document.querySelectorAll(`#colorSettings .color-swatch-inline[data-id="${id}"]`).forEach(d=>d.style.background=color);
}

function changeMonth(d){calMonth+=d;if(calMonth>11){calMonth=0;calYear++;}if(calMonth<0){calMonth=11;calYear--;}renderCal();}
function goToday(){calYear=new Date().getFullYear();calMonth=new Date().getMonth();renderCal();}
function setView(v){calView=v;document.getElementById('viewMonth').classList.toggle('active',v==='month');document.getElementById('viewList').classList.toggle('active',v==='list');renderCal();}
function getVisibleEvents(){return allAssignments.filter(a=>a.due_at&&visibleCourseIds.has(a.course_id));}

function renderCal(){
  document.getElementById('calMonthLabel').textContent=new Date(calYear,calMonth,1).toLocaleString('default',{month:'long',year:'numeric'});
  calView==='month'?renderMonthGrid():renderListView();
}

function renderMonthGrid(){
  const wrap=document.getElementById('calGridWrap');
  const today=new Date();today.setHours(0,0,0,0);
  const firstDay=new Date(calYear,calMonth,1);
  const lastDay=new Date(calYear,calMonth+1,0);
  const startOffset=firstDay.getDay();
  const events=getVisibleEvents();
  const byDate={};
  events.forEach(a=>{
    const d=new Date(a.due_at);
    const key=`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if(!byDate[key])byDate[key]=[];
    byDate[key].push(a);
  });
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html=`<div class="cal-grid">`;
  days.forEach(d=>{html+=`<div class="cal-day-hdr">${d}</div>`;});
  for(let i=0;i<startOffset;i++){
    const d=new Date(calYear,calMonth,-(startOffset-i-1));
    html+=`<div class="cal-day other-month"><div class="day-num">${d.getDate()}</div></div>`;
  }
  for(let d=1;d<=lastDay.getDate();d++){
    const date=new Date(calYear,calMonth,d);
    const key=`${calYear}-${calMonth}-${d}`;
    const dayEvts=byDate[key]||[];
    const isToday=date.getTime()===today.getTime();
    const maxShow=3;
    html+=`<div class="cal-day${isToday?' today':''}">`;
    html+=`<div class="day-num">${d}</div>`;
    dayEvts.slice(0,maxShow).forEach(a=>{
      html+=`<div class="day-event" style="background:${a.color}" data-cs-onclick="openEventModal(${a.id})" title="${a.name}">${a.name}</div>`;
    });
    if(dayEvts.length>maxShow)html+=`<div class="day-more">+${dayEvts.length-maxShow} more</div>`;
    html+=`</div>`;
  }
  const totalCells=Math.ceil((startOffset+lastDay.getDate())/7)*7;
  const remaining=totalCells-(startOffset+lastDay.getDate());
  for(let i=1;i<=remaining;i++)html+=`<div class="cal-day other-month"><div class="day-num">${i}</div></div>`;
  html+=`</div>`;
  wrap.innerHTML=html;
}

function renderListView(){
  const wrap=document.getElementById('calGridWrap');
  const events=getVisibleEvents().sort((a,b)=>new Date(a.due_at)-new Date(b.due_at));
  if(!events.length){wrap.innerHTML='<div style="padding:2rem;text-align:center;color:var(--muted);font-size:13px">No assignments to show for selected courses.</div>';return;}
  const groups={};
  events.forEach(a=>{
    const key=new Date(a.due_at).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    if(!groups[key])groups[key]=[];
    groups[key].push(a);
  });
  let html='<div class="cal-list">';
  Object.entries(groups).forEach(([date,evts])=>{
    html+=`<div class="list-date-hdr">${date}</div>`;
    evts.forEach(a=>{
      const time=new Date(a.due_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      const pts=a.points_possible?`${a.points_possible} pts`:'';
      html+=`<div class="list-event-row" data-cs-onclick="openEventModal(${a.id})">
        <div class="list-dot" style="background:${a.color}"></div>
        <div class="list-info"><div class="list-name">${a.name}</div><div class="list-course">${a.course_name}</div></div>
        <div class="list-time">${time}</div>
        ${pts?`<div class="list-pts">${pts}</div>`:''}
      </div>`;
    });
  });
  html+='</div>';
  wrap.innerHTML=html;
}

function openEventModal(id){
  const a=allAssignments.find(x=>x.id===id);
  if(!a)return;
  currentEvent=a;
  const due=new Date(a.due_at);
  const dueFmt=due.toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  document.getElementById('modalTitle').textContent=a.name;
  document.getElementById('modalCourse').innerHTML=`<div class="course-dot" style="background:${a.color};width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px"></div>${a.course_name}`;
  let bodyHTML=`<div class="row"><strong>Due:</strong> ${dueFmt}</div>`;
  bodyHTML+=`<div class="row"><strong>Points:</strong> ${a.points_possible||'N/A'}</div>`;
  if(a.submission?.submitted_at)bodyHTML+=`<div class="row"><strong>Submitted:</strong> ${new Date(a.submission.submitted_at).toLocaleString()}</div>`;
  if(a.submission?.score!=null)bodyHTML+=`<div class="row"><strong>Score:</strong> ${a.submission.score} / ${a.points_possible}</div>`;
  if(a.submission?.missing)bodyHTML+=`<div class="row" style="color:var(--rust)">⚠ Missing</div>`;
  if(a.submission?.late)bodyHTML+=`<div class="row" style="color:#f59e0b">⏰ Submitted late</div>`;
  if(a.description){const desc=a.description.replace(/<[^>]*>/g,'').trim().slice(0,200);if(desc)bodyHTML+=`<div class="row" style="margin-top:8px;font-size:12px;color:var(--muted)">${desc}…</div>`;}
  document.getElementById('modalBody').innerHTML=bodyHTML;
  const gcalUrl=buildGCalURL(a);
  const submitUrl=`https://${canvasDomain}/courses/${a.course_id}/assignments/${a.id}`;
  const alreadySubmitted=!!a.submission?.submitted_at;
  document.getElementById('modalActions').innerHTML=`
    ${alreadySubmitted
      ? '<span style="font-size:12px;color:var(--green);padding:6px 0;display:flex;align-items:center;gap:4px">✓ Already Submitted</span>'
      : `<a class="submit-link" href="${submitUrl}" target="_blank">📤 Submit Assignment</a>`}
    <button type="button" class="modal-btn primary" data-cs-onclick="viewCurrentEventCanvasContent()">View content</button>
    <a class="modal-btn" href="${submitUrl}" target="_blank">🔗 Open in Canvas</a>
    <a class="modal-btn" href="${gcalUrl}" target="_blank">📅 Add to Calendar</a>
    <button class="modal-btn" data-cs-onclick="downloadSingleICS()">Download .ics</button>
    <button class="modal-btn" data-cs-onclick="closeModal()">Close</button>`;
  document.getElementById('modalOverlay').classList.add('open');
}

function viewCurrentEventCanvasContent(){
  if(!currentEvent)return;
  const c=courses.find(x=>x.id===currentEvent.course_id);
  if(!c)return;
  closeModal();
  openContentViewer({type:'assignment',courseId:currentEvent.course_id,course:c,assignmentId:currentEvent.id});
}

function maybeCloseModal(e){if(e.target===document.getElementById('modalOverlay'))closeModal();}
function closeModal(){document.getElementById('modalOverlay').classList.remove('open');}
function downloadSingleICS(){if(currentEvent)downloadBlob(buildSingleICS(currentEvent),'text/calendar',`${currentEvent.name.replace(/[^a-z0-9]/gi,'_')}.ics`);}

// ── ICS GENERATION ─────────────────────────────────────────────────────────
function fmtICS(dateStr){return new Date(dateStr).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');}
function escICS(s){return(s||'').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');}

function buildSingleICS(a){
  const start=fmtICS(a.due_at);
  const end=fmtICS(new Date(new Date(a.due_at).getTime()+3600000).toISOString());
  return['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Canvas Study App//EN','CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',`DTSTART:${start}`,`DTEND:${end}`,
    `SUMMARY:${escICS(a.name)}`,
    `DESCRIPTION:Course: ${escICS(a.course_name)}\\nPoints: ${a.points_possible||'N/A'}`,
    `CATEGORIES:${escICS(a.course_name)}`,`UID:canvas-${a.id}@canvasstudy`,
    'END:VEVENT','END:VCALENDAR'].join('\r\n');
}

function exportICS(mode){
  const evts=mode==='visible'
    ?allAssignments.filter(a=>a.due_at&&visibleCourseIds.has(a.course_id))
    :allAssignments.filter(a=>a.due_at);
  if(!evts.length){alert('No assignments with due dates found.');return;}
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Canvas Study App//EN','CALSCALE:GREGORIAN','X-WR-CALNAME:Canvas Assignments'];
  evts.forEach(a=>{
    const start=fmtICS(a.due_at);
    const end=fmtICS(new Date(new Date(a.due_at).getTime()+3600000).toISOString());
    lines.push('BEGIN:VEVENT',`DTSTART:${start}`,`DTEND:${end}`,
      `SUMMARY:${escICS(a.name)} [${escICS(a.course_code||a.course_name)}]`,
      `DESCRIPTION:Course: ${escICS(a.course_name)}\\nPoints: ${a.points_possible||'N/A'}`,
      `CATEGORIES:${escICS(a.course_name)}`,`UID:canvas-${a.id}@canvasstudy`,'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  downloadBlob(lines.join('\r\n'),'text/calendar','canvas-assignments.ics');
}

function buildGCalURL(a){
  const start=fmtICS(a.due_at);
  const end=fmtICS(new Date(new Date(a.due_at).getTime()+3600000).toISOString());
  const p=new URLSearchParams({action:'TEMPLATE',text:`${a.name} [${a.course_code||a.course_name}]`,dates:`${start}/${end}`,details:`Course: ${a.course_name}\nPoints: ${a.points_possible||'N/A'}`});
  return`https://calendar.google.com/calendar/render?${p}`;
}

function openGCalBulk(){
  const evts=getVisibleEvents().filter(a=>a.due_at).slice(0,3);
  if(!evts.length){alert('No assignments with due dates visible.');return;}
  alert(`Opening first ${evts.length} assignments in Google Calendar. Allow popups if prompted.`);
  evts.forEach((a,i)=>setTimeout(()=>window.open(buildGCalURL(a),'_blank'),i*600));
}

function downloadBlob(content,type,filename){
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ── SETTINGS ───────────────────────────────────────────────────────────────
function buildSettings(self){
  if(self){document.getElementById('settingsUser').textContent=self.name;document.getElementById('settingsDomain').textContent=canvasDomain;}
  const el=document.getElementById('colorSettings');
  el.innerHTML='';
  courses.forEach(c=>{
    const row=document.createElement('div');
    row.className='color-settings-row';
    row.innerHTML=`<label><div class="color-swatch color-swatch-inline" data-id="${c.id}" style="background:${courseColors[c.id]};width:18px;height:18px;display:inline-block;border-radius:50%;border:2px solid rgba(0,0,0,0.1);position:relative;cursor:pointer">
      <input type="color" value="${courseColors[c.id]}" data-cs-onchange="changeCourseColor(${c.id},this.value)" style="position:absolute;opacity:0;inset:0;cursor:pointer;width:100%;height:100%;border:none;padding:0"/></div>
      ${c.name}</label><small style="font-size:11px;color:var(--muted)">${c.course_code||''}</small>`;
    el.appendChild(row);
  });
}

// ── CANVAS TOOLS ───────────────────────────────────────────────────────────
async function tool_getCourses(){const d=await proxyGet('/api/v1/courses?enrollment_state=active&per_page=30&include[]=total_scores');return d.filter(c=>c.name).map(c=>({id:c.id,name:c.name,code:c.course_code,grade:c.enrollments?.[0]?.computed_current_score??null,letter:c.enrollments?.[0]?.computed_current_grade??null}));}
async function tool_getAssignments({course_id,include_past,include_upcoming}){const rel=course_id?courses.filter(c=>String(c.id)===String(course_id)):courses.slice(0,15);const results=[];await Promise.all(rel.map(async c=>{let url=`/api/v1/courses/${c.id}/assignments?per_page=50&order_by=due_at`;if(include_upcoming===false)url+='&bucket=past';else if(include_past===false)url+='&bucket=upcoming';const data=await proxyGet(url).catch(()=>[]);data.forEach(a=>results.push({course:c.name,course_id:c.id,id:a.id,name:a.name,due_at:a.due_at,points:a.points_possible,submitted:a.has_submitted_submissions}));}));return results;}
async function tool_getGrades({course_id}){const rel=course_id?courses.filter(c=>String(c.id)===String(course_id)):courses.slice(0,15);const results=[];await Promise.all(rel.map(async c=>{const data=await proxyGet(`/api/v1/courses/${c.id}/assignments?per_page=50&include[]=submission`).catch(()=>[]);data.forEach(a=>{if(a.submission)results.push({course:c.name,assignment:a.name,score:a.submission.score,possible:a.points_possible,grade:a.submission.grade,submitted_at:a.submission.submitted_at,late:a.submission.late,missing:a.submission.missing});});}));return results;}
async function tool_getSubmissions({course_id}){const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);return proxyGet(`/api/v1/courses/${cid}/students/submissions?student_ids[]=self&per_page=50&include[]=assignment`).catch(()=>[]);}
async function tool_getAnnouncements({course_id}){const codes=course_id?[`course_${course_id}`]:courses.slice(0,15).map(c=>`course_${c.id}`);return proxyGet(`/api/v1/announcements?${codes.map(c=>`context_codes[]=${c}`).join('&')}&per_page=20&active_only=true`).catch(()=>[]);}
async function tool_getModules({course_id}){const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);return proxyGet(`/api/v1/courses/${cid}/modules?per_page=20&include[]=items`).catch(()=>[]);}
async function tool_getSyllabus({course_id}){const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);const data=await proxyGet(`/api/v1/courses/${cid}?include[]=syllabus_body`).catch(()=>null);if(!data?.syllabus_body)return'No syllabus found.';return data.syllabus_body.replace(/<[^>]*>/g,'').slice(0,3000);}


async function tool_getMaterials({course_id}){
  const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);
  const c=courses.find(x=>x.id===cid)||courses[0];
  const baseUrl=`https://${canvasDomain}`;
  const [modules,files]=await Promise.all([
    proxyGet(`/api/v1/courses/${cid}/modules?per_page=20&include[]=items`).catch(()=>[]),
    proxyGet(`/api/v1/courses/${cid}/files?per_page=30&sort=updated_at&order=desc`).catch(()=>[])
  ]);
  const items=[];
  (Array.isArray(modules)?modules:[]).forEach(m=>{
    (m.items||[]).forEach(i=>{
      items.push({
        module:m.name,type:i.type,title:i.title,
        url:i.html_url||`${baseUrl}/courses/${cid}`,
        external_url:i.external_url||null,
        page_url:i.page_url||null
      });
    });
  });
  const fileList=(Array.isArray(files)?files:[]).map(f=>({
    name:f.display_name,size:f.size,url:f.url,
    type:f.content_type,updated:f.updated_at,
    view_url:`${baseUrl}/courses/${cid}/files/${f.id}`
  }));
  return {course:c?.name,modules:items,files:fileList,course_url:`${baseUrl}/courses/${cid}`};
}

async function tool_getPages({course_id}){
  const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);
  const data=await proxyGet(`/api/v1/courses/${cid}/pages?per_page=30&sort=updated_at`).catch(()=>[]);
  const baseUrl=`https://${canvasDomain}`;
  return (Array.isArray(data)?data:[]).map(p=>({
    title:p.title,url:`${baseUrl}/courses/${cid}/pages/${p.url}`,
    updated:p.updated_at,published:p.published
  }));
}

async function tool_getPageContent({course_id,page_url,full_excerpt}){
  const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);
  const data=await proxyGet(`/api/v1/courses/${cid}/pages/${page_url}`).catch(()=>null);
  if(!data)return'Page not found.';
  const plain=(data.body||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const cap=full_excerpt?12000:4500;
  return{title:data.title,body:plain.slice(0,cap),truncated:(plain.length>cap)};
}

async function tool_getAssignmentDetails({course_id,assignment_id}){
  const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);
  const baseUrl=`https://${canvasDomain}`;
  let assignments;
  if(assignment_id){
    const a=await proxyGet(`/api/v1/courses/${cid}/assignments/${assignment_id}?include[]=submission&include[]=rubric`).catch(()=>null);
    assignments=a?[a]:[];
  }else{
    assignments=await proxyGet(`/api/v1/courses/${cid}/assignments?per_page=30&order_by=due_at&include[]=submission`).catch(()=>[]);
  }
  return (Array.isArray(assignments)?assignments:[]).map(a=>{
    const descPlain=(a.description||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
    return{
      id:a.id,name:a.name,due_at:a.due_at,points:a.points_possible,graded_type:a.graded_type||null,
      quiz_id:a.quiz_id||null,classify:classifyAssessment(a),
      description_plain:descPlain,
      submission_types:a.submission_types,
      view_url:`${baseUrl}/courses/${cid}/assignments/${a.id}`,
      submit_url:`${baseUrl}/courses/${cid}/assignments/${a.id}`,
      submitted:!!a.submission?.submitted_at,score:a.submission?.score,grade:a.submission?.grade,
      missing:a.submission?.missing,late:a.submission?.late
    };
  });
}

async function tool_getQuiz({course_id,quiz_id}){
  if(!quiz_id)return{error:'quiz_id required'};
  const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);
  const quiz=await fetchQuizFull(cid,quiz_id).catch(()=>null);
  if(!quiz)return{error:'Quiz not found'};
  const baseUrl=`https://${canvasDomain}`;
  const descPlain=(quiz.description||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
  return{
    id:quiz.id,title:quiz.title,question_count:quiz.question_count,
    time_limit:quiz.time_limit,allowed_attempts:quiz.allowed_attempts,
    lock_at:quiz.lock_at,unlock_at:quiz.unlock_at,due_at:quiz.due_at,quiz_type:quiz.quiz_type||null,
    description_plain:descPlain,
    canvas_url:`${baseUrl}/courses/${cid}/quizzes/${quiz.id}`
  };
}

async function tool_getSavedLibrary({query,course_id,type,max_items}){
  let items=[];
  try{items=await libGetAll();}catch(e){return{items:[],hint:'IndexedDB unavailable'};}
  const q=(query||'').toLowerCase();
  let filtered=items;
  if(course_id)filtered=filtered.filter(r=>String(r.courseId)===String(course_id));
  if(type)filtered=filtered.filter(r=>r.type===type);
  if(q)filtered=filtered.filter(r=>(r.title+' '+(r.contentText||'')+' '+(r.notes||'')).toLowerCase().includes(q));
  filtered.sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));
  const cap=Math.min(Math.max(1,+max_items||12),35);
  return filtered.slice(0,cap).map(r=>({id:r.id,title:r.title,type:r.type,course:r.courseName,excerpt:(r.contentText||'').slice(0,2400)}));
}

async function tool_getCourseFiles({course_id}){
  const cid=course_id||(activeCourse?activeCourse.id:courses[0]?.id);
  const baseUrl=`https://${canvasDomain}`;
  const files=await proxyGet(`/api/v1/courses/${cid}/files?per_page=50&sort=updated_at&order=desc`).catch(()=>[]);
  return (Array.isArray(files)?files:[]).map(f=>({
    id:f.id,name:f.display_name,
    size:f.size,type:f.content_type,
    updated:f.updated_at,
    download_url:f.url,
    view_url:`${baseUrl}/courses/${cid}/files/${f.id}`
  }));
}

const TOOL_MAP={get_courses:tool_getCourses,get_assignments:tool_getAssignments,get_grades:tool_getGrades,get_submissions:tool_getSubmissions,get_announcements:tool_getAnnouncements,get_modules:tool_getModules,get_syllabus:tool_getSyllabus,get_materials:tool_getMaterials,get_pages:tool_getPages,get_page_content:tool_getPageContent,get_assignment_details:tool_getAssignmentDetails,get_course_files:tool_getCourseFiles,get_quiz:tool_getQuiz,get_saved_library:tool_getSavedLibrary};
const TOOLS=[
  WEB_TOOL_DEF,
  {name:'get_courses',description:'List active courses with grades.',input_schema:{type:'object',properties:{},required:[]}},
  {name:'get_assignments',description:'Get assignments. include_past/include_upcoming booleans to filter.',input_schema:{type:'object',properties:{course_id:{type:'number'},include_past:{type:'boolean'},include_upcoming:{type:'boolean'}},required:[]}},
  {name:'get_grades',description:'Get grades and submission status.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_submissions',description:'Get submission data for a course.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_announcements',description:'Get recent announcements.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_modules',description:'Get course modules and items.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_syllabus',description:'Get course syllabus.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_materials',description:'Get all course materials: module items, files, pages, and links. Use this when asked about course content, readings, or resources.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_pages',description:'List all Canvas pages/wiki pages for a course.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_page_content',description:'Get Canvas page plain text by page_url slug. Use full_excerpt=true for longer reads.',input_schema:{type:'object',properties:{course_id:{type:'number'},page_url:{type:'string',description:'Slug from get_pages'},full_excerpt:{type:'boolean'}},required:['page_url']}},
  {name:'get_assignment_details',description:'Get assignment instructions (long plain text), submission info, quiz_id when linked, graded type.',input_schema:{type:'object',properties:{course_id:{type:'number'},assignment_id:{type:'number'}},required:[]}},
  {name:'get_quiz',description:'Get quiz/exam metadata and instructions by quiz ID (often from quiz_id on assignments). Questions may still be inaccessible via API.',input_schema:{type:'object',properties:{course_id:{type:'number'},quiz_id:{type:'number'}},required:['quiz_id']}},
  {name:'get_course_files',description:'List all files uploaded to a course with download links.',input_schema:{type:'object',properties:{course_id:{type:'number'}},required:[]}},
  {name:'get_saved_library',description:'Search the student-owned saved Library snapshots (offline).',input_schema:{type:'object',properties:{query:{type:'string'},course_id:{type:'number'},type:{type:'string'},max_items:{type:'number'}},required:[]}}
];
const TUTOR_CANVAS_TOOLS_WITHOUT_WEB=TOOLS.slice(1);

async function runAgent(userMessage){
  const courseList=courses.map(c=>`- ${c.name} (ID:${c.id}, code:${c.course_code||'N/A'})`).join('\n');
  const focus=activeCourse?`Focused on: ${activeCourse.name} (ID:${activeCourse.id})`:'All courses.';
  const system=`You are a Canvas LMS academic assistant with live access to the student's Canvas account, course materials, files, pages, and the web.

Courses:
${courseList}
${focus}
Canvas base URL: https://${canvasDomain}

TOOLS AVAILABLE:
- get_assignments / get_assignment_details / get_quiz: assignments, quizzes, due dates, grades, long instructions
- get_saved_library: student-owned saved Library snapshots (textbooks, snapshots)
- get_materials: course modules, files, pages, external resources
- get_pages / get_page_content: Canvas wiki/content pages with full text
- get_course_files: uploaded files with download links
- get_grades / get_submissions: grade details
- get_announcements / get_syllabus: course info
- web_search: external research, concepts, tutorials

RESPONSE RULES:
1. Always use tools to fetch real data before answering questions about assignments, materials, or grades.
2. For every assignment mentioned, include a clickable link formatted as: [View/Submit](https://${canvasDomain}/courses/COURSE_ID/assignments/ASSIGNMENT_ID)
3. For course files, include: [Download FILE_NAME](download_url)
4. For Canvas pages, include: [Open Page](view_url)  
5. For courses, include: [Open Course](https://${canvasDomain}/courses/COURSE_ID)
6. Format responses clearly: use **bold** for assignment names, bullet points for lists.
7. When asked about materials or content, call get_materials first to see what's available.
8. Be specific about dates, points, and submission status.`;
  const msgs=document.getElementById('messages');
  let messages=[...chatHistory,{role:'user',content:userMessage}];
  while(true){
    const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':anthropicKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:ANTHROPIC_MODEL,max_tokens:2048,system,tools:TOOLS,messages})});
    if(!res.ok){const e=await res.json().catch(()=>({error:{message:res.statusText}}));throw new Error(e.error?.message||res.statusText);}
    const data=await res.json();
    messages.push({role:'assistant',content:data.content});
    if(data.stop_reason==='end_turn')return data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if(data.stop_reason==='tool_use'){
      document.querySelectorAll('.msg.ai').forEach(el=>{if(el.querySelector('.typing'))el.remove();});
      const toolBlocks=data.content.filter(b=>b.type==='tool_use');
      const toolResults=[];
      for(const tb of toolBlocks){
        const isWeb=tb.name==='web_search';
        const pill=document.createElement('div');
        pill.className=`tool-pill ${isWeb?'web-tool':'canvas-tool'}`;
        pill.textContent=isWeb?`Searching: "${tb.input?.query||''}"…`:`Canvas: ${tb.name.replace('get_','').replace(/_/g,' ')}…`;
        msgs.appendChild(pill);msgs.scrollTop=msgs.scrollHeight;
        let result;
        if(TOOL_MAP[tb.name]){try{result=JSON.stringify(await TOOL_MAP[tb.name](tb.input||{}));}catch(e){result=JSON.stringify({error:e.message});}}
        else result=JSON.stringify({error:`Unknown tool: ${tb.name}`});
        pill.textContent=pill.textContent.replace('…','');
        toolResults.push({type:'tool_result',tool_use_id:tb.id,content:result});
      }
      messages.push({role:'user',content:toolResults});
      addTyping();
      continue;
    }
    return data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'Done.';
  }
}

async function runStudyTutor(userMessage,godMode,preferCourseOnly){
  const courseList=courses.map(c=>`- ${c.name} (ID:${c.id}, code:${c.course_code||'N/A'})`).join('\n');
  const focusVal=document.getElementById('tutorCourseFocus')?.value;
  const fc=focusVal?courses.find(c=>String(c.id)===focusVal):null;
  const focusLine=fc?`Course focus (default tools): ${fc.name} (${fc.id}).`:'All courses — pass course_id in tools when needed.';

  const system=godMode
    ?`GOD MODE (one turn): comply directly—and completely—with the student's request including full answers or code when asked, grounded in tools/web/instructions. NEVER fabricate unpublished Canvas quiz questions from APIs; admit gaps. Courses:\n${courseList}\n${focusLine}\nCanvas: https://${canvasDomain}`
    :`You are Study Tutor: grounded, patient tutoring aligned with your Canvas courses.\nUse modules, syllabus, announcements, wiki pages, assignment & quiz instructions, and saved Library (get_saved_library) before improvisation.\nCall web_search only after Canvas is checked—or when supplemental web context is explicitly useful—and label instructor vs outside sources.\nYou cannot reliably pull locked quiz/question bank content through API paths; tutor from published instructions plus practice/strategy.\nCourses:\n${courseList}\n${focusLine}\nCanvas base: https://${canvasDomain}`;

  const tutorTools=buildTutorToolList(godMode,preferCourseOnly);
  const msgsEl=document.getElementById('tutorMessages');
  let messages=[...tutorChatHistory,{role:'user',content:userMessage}];

  while(true){
    const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':anthropicKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:ANTHROPIC_MODEL,max_tokens:4096,system,tools:tutorTools,messages})});
    if(!res.ok){const e=await res.json().catch(()=>({error:{message:res.statusText}}));throw new Error(e.error?.message||res.statusText);}
    const data=await res.json();
    messages.push({role:'assistant',content:data.content});
    if(data.stop_reason==='end_turn')return data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if(data.stop_reason==='tool_use'){
      document.querySelectorAll('#tutorMessages .msg.ai').forEach(el=>{if(el.querySelector('.typing'))el.remove();});
      const toolBlocks=data.content.filter(b=>b.type==='tool_use');
      const toolResults=[];
      for(const tb of toolBlocks){
        const isWeb=tb.name==='web_search';
        const pill=document.createElement('div');
        pill.className=`tool-pill ${isWeb?'web-tool':'canvas-tool'}`;
        pill.textContent=isWeb?`Searching: "${tb.input?.query||''}"…`:`Canvas: ${tb.name.replace('get_','').replace(/_/g,' ')}…`;
        msgsEl.appendChild(pill);msgsEl.scrollTop=msgsEl.scrollHeight;
        let result;
        if(TOOL_MAP[tb.name]){try{result=JSON.stringify(await TOOL_MAP[tb.name](tb.input||{}));}catch(e){result=JSON.stringify({error:e.message});}}
        else result=JSON.stringify({error:`Unknown tool: ${tb.name}`});
        pill.textContent=pill.textContent.replace('…','');
        const excerpt=(typeof result==='string'?result:'').slice(0,2600);
        recordSource(isWeb?'web':'canvas',tb.name,tb.name,null,excerpt,tb.input?.course_id);
        toolResults.push({type:'tool_result',tool_use_id:tb.id,content:result});
      }
      messages.push({role:'user',content:toolResults});
      addTutorTyping();
      continue;
    }
    return data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'Done.';
  }
}

async function send(){
  const ta=document.getElementById('chatInput');
  const text=ta.value.trim();
  if(!text||isLoading)return;
  ta.value='';ta.style.height='40px';
  document.getElementById('emptyState')?.remove();
  addMessage('user',text);
  chatHistory.push({role:'user',content:text});
  isLoading=true;document.getElementById('sendBtn').disabled=true;addTyping();
  try{
    const reply=await runAgent(text);
    document.querySelectorAll('.msg.ai').forEach(el=>{if(el.querySelector('.typing'))el.remove();});
    addMessage('ai',reply);
    chatHistory.push({role:'assistant',content:reply});
    if(chatHistory.length>20)chatHistory=chatHistory.slice(-20);
  }catch(e){
    document.querySelectorAll('.msg.ai').forEach(el=>{if(el.querySelector('.typing'))el.remove();});
    addMessage('ai','Error: '+e.message);
  }
  isLoading=false;document.getElementById('sendBtn').disabled=false;
}

function renderMarkdown(text){
  // Convert markdown to safe HTML with clickable links
  let html = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // links: [text](url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,(m,label,url)=>{
      const cls = url.includes('/assignments/')&&(label.toLowerCase().includes('submit')||label.toLowerCase().includes('turn')) ? 'submit'
                : url.includes('/assignments/') ? 'view'
                : url.includes('/files/') ? 'file'
                : url.includes('/pages/') ? 'page' : 'view';
      const icon = cls==='submit'?'📤':cls==='file'?'📄':cls==='page'?'📋':'🔗';
      return `<a href="${url}" target="_blank" class="link-btn ${cls}">${icon} ${label}</a>`;
    })
    // raw URLs
    .replace(/(?<!["\(])(https?:\/\/[^\s<>")\]]+)/g,'<a href="$1" target="_blank">$1</a>')
    // bold
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/__([^_]+)__/g,'<strong>$1</strong>')
    // italic
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    // inline code
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    // headers
    .replace(/^### (.+)$/gm,'<h3>$1</h3>')
    // bullet lists
    .replace(/^[\*\-] (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs,'<ul>$1</ul>')
    // numbered lists
    .replace(/^\d+\. (.+)$/gm,'<li>$1</li>')
    // paragraphs: double newline
    .replace(/\n\n+/g,'</p><p>')
    // single newlines
    .replace(/\n/g,'<br/>');
  return '<p>' + html + '</p>';
}

function addMessage(role,text){
  const msgs=document.getElementById('messages');
  const div=document.createElement('div');
  div.className=`msg ${role}`;
  const bubble=document.createElement('div');
  if(role==='ai'){
    bubble.className='bubble rendered';
    bubble.innerHTML=renderMarkdown(text);
  } else {
    bubble.className='bubble';
    bubble.textContent=text;
  }
  div.appendChild(bubble);
  msgs.appendChild(div);
  msgs.scrollTop=msgs.scrollHeight;
}
function addTyping(){const msgs=document.getElementById('messages');const div=document.createElement('div');div.className='msg ai';div.innerHTML='<div class="bubble" style="padding:0"><div class="typing"><span></span><span></span><span></span></div></div>';msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;return div;}
function quickAsk(q){document.getElementById('chatInput').value=q;send();}
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}const ta=e.target;ta.style.height='40px';ta.style.height=Math.min(ta.scrollHeight,120)+'px';}
function showErr(msg){const el=document.getElementById('errMsg');el.innerHTML=msg;el.style.display='block';}
function attachCanvasSmartLinks(rootId){
  const root=document.getElementById(rootId);
  if(!root||root.dataset.cvSmartLinks)return;
  root.dataset.cvSmartLinks='1';
  root.addEventListener('click',onCanvasSmartLinkClick);
}
function onCanvasSmartLinkClick(e){
  const root=e.currentTarget;
  const a=e.target.closest('a[href]');if(!a||!root.contains(a))return;
  if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  const href=a.getAttribute('href');
  if(!href||!canvasDomain)return;
  let u;
  try{u=new URL(href);}catch(err){return;}
  const ok=u.hostname===canvasDomain||u.hostname.endsWith('instructure.com');if(!ok)return;
  const mc=u.pathname.match(/\/courses\/(\d+)\//);if(!mc)return;
  const cid=+mc[1];
  const course=courses.find(c=>c.id===cid);if(!course)return;
  const ma=u.pathname.match(/\/assignments\/(\d+)/);
  const mq=u.pathname.match(/\/quizzes\/(\d+)/);
  if(ma){e.preventDefault();try{closeModal();}catch(x){}openContentViewer({type:'assignment',courseId:cid,course,assignmentId:+ma[1]});return;}
  if(mq){e.preventDefault();try{closeModal();}catch(x){}openContentViewer({type:'quiz',courseId:cid,course,quizId:+mq[1]});return;}
}

// ── MATERIALS, INDEXEDDB LIBRARY, VIEWER, TUTOR UI ─────────────────────────
let currentFile=null,fileEditMode=false;
let tutorPinnedLibraryIds=[];

function openLibraryDb(){
  if(libDbPromise)return libDbPromise;
  libDbPromise=new Promise((res,rej)=>{
    const req=indexedDB.open(LIB_DB_NAME,1);
    req.onerror=()=>rej(req.error);
    req.onsuccess=()=>res(req.result);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains(LIB_STORE)){
        const st=db.createObjectStore(LIB_STORE,{keyPath:'id'});
        st.createIndex('byCourse','courseId',{unique:false});
        st.createIndex('byType','type',{unique:false});
      }
    };
  });
  return libDbPromise;
}
async function libPut(rec){
  const db=await openLibraryDb();
  return new Promise((res,rej)=>{const tx=db.transaction(LIB_STORE,'readwrite');tx.objectStore(LIB_STORE).put(rec);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});
}
async function libGet(id){
  const db=await openLibraryDb();
  return new Promise((res,rej)=>{const rq=db.transaction(LIB_STORE,'readonly').objectStore(LIB_STORE).get(id);rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error);});
}
async function libGetAll(){
  const db=await openLibraryDb();
  return new Promise((res,rej)=>{const rq=db.transaction(LIB_STORE,'readonly').objectStore(LIB_STORE).getAll();rq.onsuccess=()=>res(rq.result||[]);rq.onerror=()=>rej(rq.error);});
}
async function libDelete(id){
  const db=await openLibraryDb();
  return new Promise((res,rej)=>{const tx=db.transaction(LIB_STORE,'readwrite');tx.objectStore(LIB_STORE).delete(id);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});
}
function makeLibraryId(courseId,type,canvasKey){return `${courseId||'na'}:${type}:${canvasKey}`;}

function restoreTutorPrefs(){
  try{
    const p=document.getElementById('tutorPreferCourseOnly');
    const a=document.getElementById('tutorAutosaveSources');
    const h=document.getElementById('hideGodMode');
    if(p)p.checked=localStorage.getItem('tutorPreferCourseOnly')==='1';
    if(a)a.checked=localStorage.getItem('tutorAutosaveSources')==='1';
    if(h)h.checked=localStorage.getItem('hideGodMode')==='1';
  }catch(e){}
}
function persistTutorPrefs(){
  try{
    localStorage.setItem('tutorPreferCourseOnly',document.getElementById('tutorPreferCourseOnly')?.checked?'1':'0');
    localStorage.setItem('tutorAutosaveSources',document.getElementById('tutorAutosaveSources')?.checked?'1':'0');
    localStorage.setItem('hideGodMode',document.getElementById('hideGodMode')?.checked?'1':'0');
  }catch(e){}
}
function stripTags(s){return (s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();}
function sanitizeCanvasHtml(html){
  if(!html)return'';
  let h=String(html);
  h=h.replace(/href="\//g,`href="https://${canvasDomain}/`);
  h=h.replace(/src="\//g,`src="https://${canvasDomain}/`);
  if(typeof DOMPurify!=='undefined')return DOMPurify.sanitize(h,{ADD_ATTR:['target'],ALLOWED_TAGS:['p','br','a','ul','ol','li','strong','em','b','i','h1','h2','h3','h4','table','thead','tbody','tr','th','td','img','blockquote','code','pre','span','div'],ALLOWED_ATTR:['href','src','alt','title','class','colspan','rowspan','target']});
  return h.replace(/</g,'&lt;');
}

function classifyAssessment(a){
  const st=a.submission_types||[];
  const name=(a.name||'').toLowerCase();
  if(a.quiz_id||st.includes('online_quiz')){if(/\b(exam|final|midterm)\b/.test(name))return'exam';return'quiz';}
  if(st.includes('discussion_topic')||a.discussion_topic)return'discussion';
  return'assignment';
}

async function fetchAssignmentFull(courseId,assignmentId){
  return proxyGet(`/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission&include[]=rubric`);
}
async function fetchQuizFull(courseId,quizId){
  return proxyGet(`/api/v1/courses/${courseId}/quizzes/${quizId}`);
}

function fileIcon(f){
  if(f.kind==='page'||f.matKind==='page')return'📄';
  const t=(f.type||'').toLowerCase();
  if(t.includes('pdf'))return'📕';
  if(t.includes('word')||t.includes('document'))return'📝';
  if(t.includes('spreadsheet')||t.includes('excel'))return'📊';
  if(t.includes('presentation')||t.includes('powerpoint'))return'📊';
  if(t.includes('image')||t.includes('png')||t.includes('jpg'))return'🖼️';
  if(t.includes('video'))return'🎬';
  if(t.includes('audio'))return'🎵';
  if(t.includes('zip')||t.includes('archive'))return'📦';
  if(t.includes('text'))return'📃';
  return'📎';
}
function formatFileSize(bytes){
  if(!bytes)return'';
  if(bytes<1024)return bytes+' B';
  if(bytes<1048576)return (bytes/1024).toFixed(1)+' KB';
  return (bytes/1048576).toFixed(1)+' MB';
}

function initMaterialsPage(){
  if(!courses.length)return;
  const list=document.getElementById('filesCourseList');
  list.innerHTML='';
  courses.forEach(c=>{
    const el=document.createElement('div');
    el.className='course-item';
    el.innerHTML=`<div class="course-dot" style="background:${courseColors[c.id]||'#3b82f6'}"></div><div><div class="cname">${c.name}</div><div class="ccode">${c.course_code||''}</div></div>`;
    el.data-cs-onclick=()=>loadMaterialsCourse(c,el);
    list.appendChild(el);
  });
}

function setMatFilter(m,btn){
  matFilter=m;
  document.querySelectorAll('#matFilters .mat-filter-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  const mp=document.getElementById('modulesPanel');
  if(mp)mp.classList.toggle('open',m==='modules');
  filterMaterials();
}

function filterMaterials(){
  if(!activeMatCourse)return;
  const q=(document.getElementById('filesSearch').value||'').toLowerCase();
  let rows=materialsList.filter(it=>{
    if(matFilter==='modules')return false;
    if(matFilter==='all')return true;
    return it.matKind===matFilter;
  });
  rows=rows.filter(it=>(it.name||'').toLowerCase().includes(q));
  renderMaterialsCards(rows);
}

async function loadMaterialsCourse(course,el){
  document.querySelectorAll('#filesCourseList .course-item').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  activeMatCourse=course;
  const grid=document.getElementById('filesGrid');
  const loading=document.getElementById('filesLoadingMsg');
  loading.style.display='block';
  grid.innerHTML='';
  try{
    const[assignments,files,pages,modules]=await Promise.all([
      proxyGetAll(`/api/v1/courses/${course.id}/assignments?per_page=100&order_by=due_at&include[]=submission`,20).catch(()=>[]),
      proxyGetAll(`/api/v1/courses/${course.id}/files?per_page=50&sort=updated_at&order=desc`,15).catch(()=>[]),
      proxyGetAll(`/api/v1/courses/${course.id}/pages?per_page=50&sort=updated_at`,15).catch(()=>[]),
      proxyGetAll(`/api/v1/courses/${course.id}/modules?per_page=50&include[]=items`,15).catch(()=>[])
    ]);
    materialsModules=Array.isArray(modules)?modules:[];
    materialsList=[];
    (Array.isArray(assignments)?assignments:[]).forEach(a=>{
      const cls=classifyAssessment(a);
      const mk=(cls==='quiz'||cls==='exam')?'quiz':'assignment';
      materialsList.push({matKind:mk,classify:cls,id:a.id,name:a.name,due_at:a.due_at,points:a.points_possible,quiz_id:a.quiz_id,submission_types:a.submission_types,html_url:a.html_url,raw:a,course_id:course.id,course});
    });
    (Array.isArray(files)?files:[]).forEach(f=>{
      materialsList.push({matKind:'file',kind:'file',id:f.id,name:f.display_name,size:f.size,type:f.content_type,url:f.url,updated:f.updated_at,course_id:course.id,course});
    });
    (Array.isArray(pages)?pages:[]).forEach(p=>{
      materialsList.push({matKind:'page',kind:'page',id:p.url,name:p.title,updated:p.updated_at,page_url:p.url,course_id:course.id,course});
    });
    renderModulesTree();
    filterMaterials();
  }catch(e){
    grid.innerHTML=`<div class="file-empty">Error: ${e.message}</div>`;
  }
  loading.style.display='none';
}

function renderMaterialsCards(items){
  const grid=document.getElementById('filesGrid');
  if(matFilter==='modules'){grid.innerHTML='<div class="file-empty" style="grid-column:1/-1">Module outline is on the right →</div>';return;}
  if(!items.length){grid.innerHTML='<div class="file-empty"><div style="font-size:32px">📭</div><div>No items match</div></div>';return;}
  grid.innerHTML='';
  items.forEach(it=>{
    const card=document.createElement('div');
    card.className=it.matKind==='assignment'||it.matKind==='quiz'?'mat-card':'file-card';
    const updated=it.updated?new Date(it.updated).toLocaleDateString():(it.due_at?new Date(it.due_at).toLocaleDateString():'');
    const kindLabel=it.matKind==='quiz'?(it.classify==='exam'?'Exam':'Quiz'):it.matKind==='assignment'?'Assignment':it.matKind==='page'?'Page':'File';
    const icon=it.matKind==='quiz'?'📝':it.matKind==='assignment'?'📌':fileIcon(it);
    card.innerHTML=`<div class="file-card-icon">${icon}</div><div class="file-card-name">${it.name}</div><div class="file-card-meta">${kindLabel}${it.points?` · ${it.points} pts`:''}${updated?' · '+updated:''}</div>`;
    card.data-cs-onclick=()=>openMaterialsItem(it);
    grid.appendChild(card);
  });
}

function openMaterialsItem(it){
  if(!activeMatCourse)return;
  if(it.matKind==='page')openContentViewer({type:'page',courseId:activeMatCourse.id,course:activeMatCourse,pageSlug:it.page_url,title:it.name});
  else if(it.matKind==='file')openContentViewer({type:'file',courseId:activeMatCourse.id,course:activeMatCourse,fileRef:it});
  else openContentViewer({type:'assignment',courseId:activeMatCourse.id,course:activeMatCourse,assignmentId:it.id,quizHintId:it.quiz_id});
}

function renderModulesTree(){
  const panel=document.getElementById('modulesPanel');
  if(!panel)return;
  panel.innerHTML='';
  materialsModules.slice().sort((a,b)=>((a.position??0)-(b.position??0))).forEach(mod=>{
    const blk=document.createElement('div');
    blk.className='mod-block';
    const hdr=document.createElement('div');
    hdr.className='mod-name';
    hdr.innerHTML=`<span>${mod.name||'Module'}</span><span>▾</span>`;
    hdr.data-cs-onclick=()=>blk.classList.toggle('expanded');
    const itemsDiv=document.createElement('div');
    itemsDiv.className='mod-items';
    (mod.items||[]).slice().sort((a,b)=>((a.position??0)-(b.position??0))).forEach(mi=>{
      const row=document.createElement('div');
      row.className='mod-item';
      row.textContent=`${mi.type||'?'}: ${mi.title||''}`;
      row.data-cs-onclick=e=>{e.stopPropagation();openModuleItem(mi);};
      itemsDiv.appendChild(row);
    });
    blk.appendChild(hdr);
    blk.appendChild(itemsDiv);
    panel.appendChild(blk);
  });
}

function openModuleItem(mi){
  if(!activeMatCourse)return;
  const c=activeMatCourse;
  const t=mi.type||'';
  if(t==='Assignment')openContentViewer({type:'assignment',courseId:c.id,course:c,assignmentId:mi.content_id});
  else if(t==='Quiz')openContentViewer({type:'quiz',courseId:c.id,course:c,quizId:mi.content_id});
  else if(t==='Page')openContentViewer({type:'page',courseId:c.id,course:c,pageSlug:mi.page_url,title:mi.title});
  else if(t==='File')openContentViewer({type:'file',courseId:c.id,course:c,fileRef:{kind:'file',id:mi.content_id,name:mi.title,url:''}});
  else if(t==='ExternalUrl'||t==='ExternalTool'){
    const url=mi.external_url||mi.url||'#';
    openContentViewer({type:'external',courseId:c.id,course:c,title:mi.title||'Link',externalUrl:url});
  }else openContentViewer({type:'external',courseId:c.id,course:c,title:mi.title||t,externalUrl:mi.html_url||mi.url||''});
}

async function openContentViewer(spec){
  viewerCtx={...spec};
  viewerLoad=null;
  currentFile=null;
  fileEditMode=false;
  const ov=document.getElementById('fileViewerOverlay');
  const fvTitle=document.getElementById('fvTitle');
  const badge=document.getElementById('cvTypeBadge');
  const meta=document.getElementById('cvMetaLine');
  const qm=document.getElementById('cvQuizMeta');
  const side=document.getElementById('cvSideMeta');
  const body=document.getElementById('fvBody');
  const editBtn=document.getElementById('fvEditBtn');
  const saveBtn=document.getElementById('fvSaveBtn');
  editBtn.style.display='none';
  saveBtn.style.display='none';
  qm.style.display='none';
  side.style.display='none';
  side.innerHTML='';
  document.getElementById('cvLibHint').textContent='';
  ov.classList.add('open');
  body.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">Loading…</div>';

  const base=`https://${canvasDomain}`;

  try{
    if(spec.type==='library'){
      const r=await libGet(spec.recordId);
      if(!r){body.innerHTML='<p>Not found in library.</p>';return;}
      viewerLoad={mode:'library',record:r};
      fvTitle.textContent=r.title;
      badge.textContent=r.type;
      meta.textContent=`Saved ${new Date(r.savedAt||Date.now()).toLocaleString()} · ${r.courseName||''}`;
      body.innerHTML=`<div class="file-content-view">${sanitizeCanvasHtml(r.contentHtml||'')||'<p><i>No HTML body</i></p>'}</div>`;
      document.getElementById('cvLibHint').textContent=r.notes?`Notes: ${r.notes}`:'';
      return;
    }
    if(spec.type==='external'){
      viewerLoad={mode:'external',spec};
      fvTitle.textContent=spec.title||'External';
      badge.textContent='External';
      meta.textContent=spec.externalUrl||'';
      body.innerHTML=`<p style="margin-bottom:12px">This item opens outside the app.</p><a class="modal-btn primary" href="${spec.externalUrl}" target="_blank" rel="noopener">Open link</a>`;
      return;
    }
    if(spec.type==='page'){
      const data=await proxyGet(`/api/v1/courses/${spec.courseId}/pages/${encodeURIComponent(spec.pageSlug)}`).catch(()=>null);
      if(!data){body.innerHTML='Could not load page.';return;}
      const html=sanitizeCanvasHtml(data.body||'');
      const plain=stripTags(data.body||'');
      viewerLoad={mode:'page',page:data,course:spec.course,plain};
      currentFile={kind:'page',name:data.title,page_url:spec.pageSlug,course:spec.course,rawContent:data.body,textContent:plain};
      fvTitle.textContent=data.title;
      badge.textContent='Page';
      meta.textContent=spec.course.name;
      body.innerHTML=`<div class="file-content-view">${html||'<p><i>Empty</i></p>'}</div>`;
      editBtn.style.display='inline-block';
      editBtn.textContent='Edit';
      updateLibraryHintForViewer();
      return;
    }
    if(spec.type==='file'){
      let f=spec.fileRef;
      if(f.url)currentFile={...f,course:spec.course};
      else{
        const full=await proxyGet(`/api/v1/courses/${spec.courseId}/files/${f.id}`).catch(()=>null);
        if(full)f={kind:'file',id:full.id,name:full.display_name,size:full.size,type:full.content_type,url:full.url,updated:full.updated_at,course_id:spec.courseId};
        currentFile={...f,course:spec.course};
      }
      viewerLoad={mode:'file',file:currentFile};
      fvTitle.textContent=currentFile.name;
      badge.textContent='File';
      meta.textContent=`${formatFileSize(currentFile.size)} ${currentFile.type?'· '+currentFile.type:''}`;
      const pdf=(currentFile.type||'').toLowerCase().includes('pdf');
      body.innerHTML=`
        <div style="padding:0.5rem 0 1rem">
          <div style="font-size:28px;margin-bottom:0.75rem">${fileIcon(currentFile)}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:1rem">${spec.course.name}</div>
          ${currentFile.url&&pdf?`<iframe src="${currentFile.url}" style="width:100%;height:520px;border:0.5px solid var(--border);border-radius:8px"></iframe>`:''}
        </div>`;
      updateLibraryHintForViewer();
      return;
    }
    if(spec.type==='quiz'){
      const quiz=await fetchQuizFull(spec.courseId,spec.quizId).catch(()=>null);
      if(!quiz){body.innerHTML='Could not load quiz metadata from Canvas.';return;}
      viewerLoad={mode:'quiz',quiz,course:spec.course,plain:stripTags(quiz.description||'')};
      fvTitle.textContent=quiz.title||'Quiz';
      badge.textContent='Quiz';
      meta.textContent=`${spec.course.name}${quiz.points_possible!=null?' · '+quiz.points_possible+' pts':''}`;
      body.innerHTML=`<div class="file-content-view">${sanitizeCanvasHtml(quiz.description||'')||'<p><i>No description</i></p>'}</div>`;
      qm.style.display='block';
      qm.innerHTML=[
        quiz.question_count!=null?`<div><strong>Questions:</strong> ${quiz.question_count}</div>`:'',
        quiz.time_limit?`<div><strong>Time limit:</strong> ${quiz.time_limit} min</div>`:'',
        quiz.allowed_attempts!=null?`<div><strong>Attempts:</strong> ${quiz.allowed_attempts}</div>`:'',
        quiz.lock_at?`<div><strong>Locks:</strong> ${new Date(quiz.lock_at).toLocaleString()}</div>`:''
      ].join('');
      side.style.display='block';
      side.innerHTML=`<a class="modal-btn primary" style="display:inline-block;text-decoration:none;margin-top:6px" href="${base}/courses/${spec.courseId}/quizzes/${quiz.id}" target="_blank">Take in Canvas</a>`;
      updateLibraryHintForViewer();
      return;
    }
    if(spec.type==='assignment'){
      const a=await fetchAssignmentFull(spec.courseId,spec.assignmentId);
      if(!a){body.innerHTML='Assignment not found.';return;}
      let quiz=null;
      if(a.quiz_id)quiz=await fetchQuizFull(spec.courseId,a.quiz_id).catch(()=>null);
      const cls=classifyAssessment(a);
      const title=a.name;
      fvTitle.textContent=title;
      badge.textContent=cls==='exam'?'Exam':cls==='quiz'?'Quiz':cls==='discussion'?'Discussion':'Assignment';
      let dueLine=a.due_at?`Due: ${new Date(a.due_at).toLocaleString()}`:'No due date';
      meta.textContent=`${spec.course.name} · ${dueLine} · ${a.points_possible!=null?a.points_possible+' pts':'—'}`;
      let parts=[];
      if(a.description)parts.push(a.description);
      if(quiz?.description)parts.push(`<h3>Quiz instructions</h3>${quiz.description}`);
      const merged=parts.join('<hr style="margin:1rem 0"/>');
      const html=sanitizeCanvasHtml(merged);
      const plain=stripTags(merged);
      viewerLoad={mode:'assignment',assignment:a,quiz,course:spec.course,plain};
      body.innerHTML=`<div class="file-content-view">${html||'<p><i>No description</i></p>'}</div>`;
      if(quiz){
        qm.style.display='block';
        qm.innerHTML=[
          quiz.question_count!=null?`<div><strong>Questions:</strong> ${quiz.question_count}</div>`:'',
          quiz.time_limit?`<div><strong>Time limit:</strong> ${quiz.time_limit} min</div>`:'',
          quiz.allowed_attempts!=null?`<div><strong>Attempts:</strong> ${quiz.allowed_attempts}</div>`:'',
          quiz.lock_at?`<div><strong>Locks:</strong> ${new Date(quiz.lock_at).toLocaleString()}</div>`:'',
          quiz.unlock_at?`<div><strong>Unlocks:</strong> ${new Date(quiz.unlock_at).toLocaleString()}</div>`:''
        ].join('');
        side.style.display='block';
        side.innerHTML=`<div style="font-weight:600;color:var(--navy);margin-bottom:6px">Assessment</div>
          <p style="margin-bottom:8px">Quiz questions may only be visible inside Canvas.</p>
          <a class="modal-btn primary" style="display:inline-block;text-decoration:none" href="${base}/courses/${spec.courseId}/quizzes/${quiz.id}" target="_blank">Take in Canvas</a>`;
      }
      updateLibraryHintForViewer();
      return;
    }
  }catch(e){
    body.innerHTML=`<p style="color:var(--rust)">${e.message}</p>`;
  }
}

async function updateLibraryHintForViewer(){
  const hint=document.getElementById('cvLibHint');
  if(!viewerCtx||viewerCtx.type==='library'){hint.textContent='';return;}
  const id=libraryIdFromViewer();
  if(!id)return;
  const ex=await libGet(id);
  hint.textContent=ex?'Saved in Library (click Save to update)':'Not saved yet';
}

function libraryIdFromViewer(){
  if(!viewerLoad||!viewerCtx)return null;
  const c=viewerCtx.courseId;
  if(viewerLoad.mode==='page')return makeLibraryId(c,'page',viewerCtx.pageSlug);
  if(viewerLoad.mode==='file')return makeLibraryId(c,'file',String(viewerCtx.fileRef?.id||viewerLoad.file?.id));
  if(viewerLoad.mode==='quiz')return makeLibraryId(c,'quiz',String(viewerCtx.quizId||viewerLoad.quiz?.id));
  if(viewerLoad.mode==='assignment')return makeLibraryId(c,'assignment',String(viewerCtx.assignmentId));
  return null;
}

function buildViewerLibraryRecord(){
  if(!viewerLoad||!viewerCtx)return null;
  const canvasBase=`https://${canvasDomain}`;
  const cid=viewerCtx.courseId;
  const course=courses.find(x=>x.id===cid)||viewerCtx.course;
  const cc=course.course_code||'';
  let type='assignment',title='',contentHtml='',contentText='',canvasKey='',sourceUrl='';
  if(viewerLoad.mode==='library')return viewerLoad.record;
  if(viewerLoad.mode==='page'){
    type='page';title=viewerLoad.page.title;contentHtml=sanitizeCanvasHtml(viewerLoad.page.body||'');contentText=viewerLoad.plain||'';canvasKey=String(viewerCtx.pageSlug);sourceUrl=`${canvasBase}/courses/${cid}/pages/${encodeURIComponent(viewerCtx.pageSlug)}`;
  }
  if(viewerLoad.mode==='file'){
    type='file';title=viewerLoad.file.name;contentHtml='<p>File snapshot (binary not embedded). Use Open/Download.</p>';contentText=title;
    canvasKey=String(viewerLoad.file.id);sourceUrl=`${canvasBase}/courses/${cid}/files/${viewerLoad.file.id}`;
  }
  if(viewerLoad.mode==='quiz'){
    type='quiz';title=viewerLoad.quiz.title||'Quiz';contentHtml=sanitizeCanvasHtml(viewerLoad.quiz.description||'');contentText=stripTags(viewerLoad.quiz.description||'');canvasKey=String(viewerLoad.quiz.id);sourceUrl=`${canvasBase}/courses/${cid}/quizzes/${viewerLoad.quiz.id}`;
  }
  if(viewerLoad.mode==='assignment'){
    type=classifyAssessment(viewerLoad.assignment)==='quiz'||classifyAssessment(viewerLoad.assignment)==='exam'?'quiz':'assignment';
    title=viewerLoad.assignment.name;
    const parts=[];
    if(viewerLoad.assignment.description)parts.push(viewerLoad.assignment.description);
    if(viewerLoad.quiz?.description)parts.push(`<h3>Quiz</h3>${viewerLoad.quiz.description}`);
    contentHtml=sanitizeCanvasHtml(parts.join('<hr/>'));
    contentText=stripTags(parts.join(' '));
    canvasKey=String(viewerCtx.assignmentId);
    sourceUrl=viewerLoad.assignment.html_url||`${canvasBase}/courses/${cid}/assignments/${viewerCtx.assignmentId}`;
  }
  if(viewerLoad.mode==='external')return null;
  const id=makeLibraryId(cid,type,canvasKey);
  return{
    id,type,courseId:cid,courseName:course.name,courseCode:cc,title,savedAt:Date.now(),updatedAt:Date.now(),
    tags:[],notes:'',contentHtml,contentText,meta:{},sourceUrl
  };
}

async function saveViewerToLibraryAction(){
  const rec=buildViewerLibraryRecord();
  if(!rec){alert('Nothing to save for this item.');return;}
  const existing=await libGet(rec.id);
  if(existing){rec.tags=existing.tags;rec.notes=existing.notes;}
  await libPut(rec);
  document.getElementById('cvLibHint').textContent='Saved to Library';
  refreshLibraryList();
}

async function refreshViewerFromCanvas(){
  if(!viewerCtx)return;
  openContentViewer(viewerCtx);
}

function openCanvasViewerUrl(){
  const base=`https://${canvasDomain}`;
  if(!viewerCtx)return;
  if(viewerCtx.type==='library'){if(viewerLoad?.record?.sourceUrl)window.open(viewerLoad.record.sourceUrl,'_blank');return;}
  if(viewerCtx.type==='page')window.open(`${base}/courses/${viewerCtx.courseId}/pages/${encodeURIComponent(viewerCtx.pageSlug)}`,'_blank');
  else if(viewerCtx.type==='file')window.open(`${base}/courses/${viewerCtx.courseId}/files/${viewerCtx.fileRef.id}`,'_blank');
  else if(viewerCtx.type==='assignment')window.open(viewerLoad?.assignment?.html_url||`${base}/courses/${viewerCtx.courseId}/assignments/${viewerCtx.assignmentId}`,'_blank');
  else if(viewerCtx.type==='quiz')window.open(`${base}/courses/${viewerCtx.courseId}/quizzes/${viewerCtx.quizId}`,'_blank');
}

function downloadCurrentViewerFile(){
  if(viewerLoad?.mode==='file'&&currentFile?.url)window.open(currentFile.url,'_blank');
  else downloadCurrentFile();
}

function askAssistantAboutViewer(){
  closeFileViewer();
  showPage('chatPage',document.getElementById('tabChat'));
  const t=`Help me understand this material${viewerLoad?.assignment?': '+viewerLoad.assignment.name:viewerLoad?.page?': '+viewerLoad.page.title:''}.`;
  document.getElementById('chatInput').value=t;
  document.getElementById('chatInput').focus();
}

function studyTutorAboutViewer(){
  const preload=viewerLoad?.plain?viewerLoadTrim(viewerLoad.plain):'';
  const title=viewerLoad?.assignment?.name||viewerLoad?.page?.title||'';
  closeFileViewer();
  showPage('tutorPage',document.getElementById('tabTutor'));
  if(viewerCtx?.courseId)document.getElementById('tutorCourseFocus').value=String(viewerCtx.courseId);
  document.getElementById('tutorInput').value=(title?'['+title+'] ':'')+(preload?'Context:\n'+preload.slice(0,4000)+'\n\n':'')+'Explain this in the terminology of my course.';
  document.getElementById('tutorInput').focus();
}
function viewerLoadTrim(s){return (s||'').slice(0,12000);}

function toggleFileEdit(){
  if(!currentFile||currentFile.kind!=='page')return;
  fileEditMode=!fileEditMode;
  const body=document.getElementById('fvBody');
  const editBtn=document.getElementById('fvEditBtn');
  const saveBtn=document.getElementById('fvSaveBtn');
  if(fileEditMode){
    body.innerHTML=`<textarea class="file-content-edit" id="fileEditArea">${currentFile.textContent||''}</textarea>`;
    editBtn.textContent='Preview';saveBtn.style.display='inline-block';
  }else{
    body.innerHTML=`<div class="file-content-view">${sanitizeCanvasHtml(currentFile.rawContent||'')}</div>`;
    editBtn.textContent='Edit';saveBtn.style.display='none';
  }
}
function saveFileEdit(){
  const ta=document.getElementById('fileEditArea');if(!ta)return;
  const blob=new Blob([ta.value],{type:'text/plain'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(currentFile.name||'page')+'.txt';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),800);
}
function downloadCurrentFile(){if(currentFile?.url)window.open(currentFile.url,'_blank');}
function sendFileToChat(){
  if(!currentFile)return;
  closeFileViewer();
  showPage('chatPage',document.getElementById('tabChat'));
  const name=currentFile.name;
  const ctx=currentFile.textContent?currentFile.textContent.slice(0,1000):'';
  document.getElementById('chatInput').value=`Tell me about "${name}" from my course.${ctx?' Excerpt: '+ctx:''}`;
  document.getElementById('chatInput').focus();
}
function closeFileViewer(){document.getElementById('fileViewerOverlay').classList.remove('open');}

async function refreshLibraryList(){
  const grid=document.getElementById('libraryGrid');
  const note=document.getElementById('libStorageNote');
  if(!grid)return;
  let items=[];
  try{items=await libGetAll();}catch(e){items=[];}
  const q=(document.getElementById('libSearch')?.value||'').toLowerCase();
  const cf=document.getElementById('libCourseFilter')?.value||'';
  const tf=document.getElementById('libTypeFilter')?.value||'';
  items=items.filter(r=>{
    if(cf&&String(r.courseId)!==cf)return false;
    if(tf&&r.type!==tf)return false;
    if(q){const blob=(r.title+' '+(r.contentText||'')+' '+(r.notes||'')).toLowerCase();if(!blob.includes(q))return false;}
    return true;
  });
  items.sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));
  grid.innerHTML='';
  if(note)note.textContent=`${items.length} item(s) · local IndexedDB`;
  items.forEach(r=>{
    const card=document.createElement('div');
    card.className='mat-card';
    card.innerHTML=`<div class="file-card-icon">📚</div><div class="file-card-name">${r.title}</div><div class="file-card-meta">${r.type} · ${r.courseName||''}</div>`;
    card.data-cs-onclick=()=>openContentViewer({type:'library',recordId:r.id});
    grid.appendChild(card);
  });
  renderTutorPinPicker(items);
}
function renderTutorPinPicker(items){
  const el=document.getElementById('tutorPinPicker');
  if(!el)return;
  el.innerHTML='';
  items.slice(0,40).forEach(r=>{
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:4px';
    const pin=document.createElement('button');
    pin.type='button';
    pin.className='small-btn';
    pin.textContent=tutorPinnedLibraryIds.includes(r.id)?'✓':'＋';
    pin.data-cs-onclick=e=>{e.stopPropagation();toggleTutorPin(r.id);};
    row.innerHTML=`<span style="overflow:hidden;text-overflow:ellipsis">${r.title.slice(0,42)}</span>`;
    row.insertBefore(pin,row.firstChild);
    el.appendChild(row);
  });
}
function toggleTutorPin(id){
  const ix=tutorPinnedLibraryIds.indexOf(id);
  if(ix>=0)tutorPinnedLibraryIds.splice(ix,1);else tutorPinnedLibraryIds.push(id);
  renderTutorPinsStrip();
  refreshLibraryList();
}
function renderTutorPinsStrip(){
  const strip=document.getElementById('tutorPinnedStrip');
  if(!strip)return;
  strip.innerHTML='';
  tutorPinnedLibraryIds.forEach(id=>{
    libGet(id).then(r=>{
      if(!r)return;
      const chip=document.createElement('div');
      chip.className='tutor-pin';
      const lab=document.createElement('span');lab.textContent=r.title.slice(0,48);
      const btn=document.createElement('button');btn.type='button';btn.setAttribute('aria-label','Remove pin');btn.textContent='×';
      btn.data-cs-onclick=()=>toggleTutorPin(id);
      chip.appendChild(lab);chip.appendChild(btn);
      strip.appendChild(chip);
    });
  });
}
function showAddTextbookForm(){
  populateTutorAndLibraryUI();
  document.getElementById('addTextbookBar').style.display='block';
}
async function saveTextbookEntry(){
  const title=document.getElementById('tbTitle').value.trim();
  const cid=+document.getElementById('tbCourse').value;
  if(!title||!cid){alert('Title and course required.');return;}
  const course=courses.find(c=>c.id===cid);
  const notes=document.getElementById('tbNotes').value.trim();
  const url=document.getElementById('tbUrl').value.trim();
  const id=makeLibraryId(cid,'textbook',String(Date.now()));
  await libPut({id,type:'textbook',courseId:cid,courseName:course.name,courseCode:course.course_code||'',title,savedAt:Date.now(),updatedAt:Date.now(),tags:[],notes,contentHtml:notes?`<p>${notes.replace(/</g,'')}</p>`:'',contentText:notes,meta:{url},sourceUrl:url||''});
  document.getElementById('addTextbookBar').style.display='none';
  refreshLibraryList();
}
async function exportLibraryJson(){
  const all=await libGetAll();
  downloadBlob(JSON.stringify(all,null,2),'application/json','canvas-library-export.json');
}
async function importLibraryJson(ev){
  const f=ev.target.files?.[0];if(!f)return;
  const text=await f.text();
  const arr=JSON.parse(text);
  if(!Array.isArray(arr))return;
  for(const row of arr){if(row.id)await libPut(row);}
  refreshLibraryList();
  ev.target.value='';
}

function clearTutorChat(){
  tutorChatHistory=[];
  document.getElementById('tutorMessages').innerHTML='';
}
function addTutorMessage(role,text){
  const msgs=document.getElementById('tutorMessages');
  const div=document.createElement('div');
  div.className=`msg ${role}`;
  const bubble=document.createElement('div');
  if(role==='ai'){bubble.className='bubble rendered';bubble.innerHTML=renderMarkdown(text);}
  else{bubble.className='bubble';bubble.textContent=text;}
  div.appendChild(bubble);msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;
}
function addTutorTyping(){
  const msgs=document.getElementById('tutorMessages');
  const div=document.createElement('div');div.className='msg ai';div.innerHTML='<div class="bubble" style="padding:0"><div class="typing"><span></span><span></span><span></span></div></div>';
  msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;return div;
}
function tutorChip(t){document.getElementById('tutorInput').value=t;}
function handleTutorKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendTutor();}}

function parseGodMode(raw){
  if(document.getElementById('hideGodMode')?.checked)return{god:false,text:raw};
  const s=String(raw||'').trim();
  const re=/^(god\s*mode\s*:?|godmode\s*:?)\s*/i;
  if(re.test(s))return{god:true,text:s.replace(re,'').trim()};
  return{god:false,text:s};
}

function recordSource(kind,toolName,label,url,excerpt,courseId){
  lastReplySources.push({kind,toolName,label:label||toolName,url:url||'',excerpt:(excerpt||'').slice(0,3500),courseId:courseId??null});
}

function buildTutorToolList(god,preferCourseOnly){
  const defs=TUTOR_CANVAS_TOOLS_WITHOUT_WEB.slice();
  if(god||!preferCourseOnly)return[WEB_TOOL_DEF,...defs];
  return defs;
}

async function sendTutor(){
  const ta=document.getElementById('tutorInput');
  const raw=ta.value.trim();
  if(!raw||isTutorLoading)return;
  const {god,text}=parseGodMode(raw);
  ta.value='';ta.style.height='40px';
  persistTutorPrefs();
  lastReplySources=[];
  document.getElementById('tutorGodBanner').style.display=god?'block':'none';
  addTutorMessage('user',raw);
  tutorChatHistory.push({role:'user',content:raw});
  isTutorLoading=true;document.getElementById('tutorSendBtn').disabled=true;addTutorTyping();
  const prefer=document.getElementById('tutorPreferCourseOnly')?.checked;
  let pinPrefix='';
  if(tutorPinnedLibraryIds.length){
    const chunks=[];
    for(const pid of tutorPinnedLibraryIds){
      const r=await libGet(pid);
      if(r)chunks.push(`### ${r.title}\n${(r.contentText||stripTags(r.contentHtml||'')).slice(0,8000)}`);
    }
    if(chunks.length)pinPrefix=`The student pinned saved materials:\n---\n${chunks.join('\n---\n')}\n---\n\n`;
  }
  const userMessage=pinPrefix+text;
  try{
    const reply=await runStudyTutor(userMessage,god,prefer);
    document.querySelectorAll('#tutorMessages .msg.ai').forEach(el=>{if(el.querySelector('.typing'))el.remove();});
    addTutorMessage('ai',reply);
    tutorChatHistory.push({role:'assistant',content:reply});
    const srcLine=lastReplySources.slice(0,6).map(s=>`${s.kind==='web'?'Web':'Canvas'} — ${s.label}`).join(' · ');
    document.getElementById('tutorSourceLine').textContent=srcLine?`Sources: ${srcLine}`:'';
    if(document.getElementById('tutorAutosaveSources')?.checked)await saveTutorSourcesBundle(true);
  }catch(e){
    document.querySelectorAll('#tutorMessages .msg.ai').forEach(el=>{if(el.querySelector('.typing'))el.remove();});
    addTutorMessage('ai','Error: '+e.message);
  }
  isTutorLoading=false;document.getElementById('tutorSendBtn').disabled=false;
}

async function saveTutorSourcesBundle(silent){
  if(!lastReplySources.length){if(!silent)alert('No sources recorded for the last reply.');return;}
  const focus=document.getElementById('tutorCourseFocus')?.value;
  const cid=focus?+focus:(courses[0]?.id)||0;
  const course=courses.find(c=>c.id===cid)||{name:'',course_code:'',id:cid};
  const id=makeLibraryId(cid,'tutor_sources_bundle',String(Date.now()));
  const title=`Tutor session ${new Date().toLocaleString()}`;
  const contentText=lastReplySources.map(s=>`${s.label}\n${s.excerpt}`).join('\n\n---\n\n');
  await libPut({id,type:'tutor_sources_bundle',courseId:cid,courseName:course.name,courseCode:course.course_code||'',title,savedAt:Date.now(),updatedAt:Date.now(),tags:['auto'],notes:'',contentHtml:`<pre style="white-space:pre-wrap;font-size:12px">${contentText.replace(/</g,'&lt;')}</pre>`,contentText,meta:{sources:lastReplySources},sourceUrl:''});
  if(!silent)alert('Saved source bundle to Library.');
  refreshLibraryList();
}

// ── PLANNER STATE ────────────────────────────────────────────────────────
const PLANNER_KEY = 'canvasPlanner_v1';
let plannerWeekStart = getWeekStart(new Date());
let plannerData = {};
let plannerView = 'grid';
let editingBlockId = null;

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HOURS_START = 6;   // 6:00 AM
const HOURS_END   = 23;  // 11:00 PM (last row 11:30)
const SLOTS = (HOURS_END - HOURS_START) * 2; // 34 slots (6:00–10:30)

function getWeekStart(d) {
  const s = new Date(d);
  s.setHours(0,0,0,0);
  s.setDate(s.getDate() - s.getDay()); // Sunday
  return s;
}

function weekKey(d) {
  const y = d.getFullYear();
  const s = new Date(d); s.setHours(0,0,0,0); s.setDate(s.getDate() - s.getDay());
  const jan1 = new Date(y,0,1);
  const week = Math.ceil(((s - jan1)/86400000 + jan1.getDay()+1)/7);
  return `${y}-W${String(week).padStart(2,'0')}`;
}

function loadPlannerData() {
  try { plannerData = JSON.parse(localStorage.getItem(PLANNER_KEY)||'{}'); } catch(e) { plannerData = {}; }
}
function savePlannerData() {
  try { localStorage.setItem(PLANNER_KEY, JSON.stringify(plannerData)); } catch(e) {}
}
function getWeekData(wk) {
  if (!plannerData[wk]) plannerData[wk] = { blocks: [], tid: {0:{tasks:[],reflection:''},1:{tasks:[],reflection:''},2:{tasks:[],reflection:''},3:{tasks:[],reflection:''},4:{tasks:[],reflection:''},5:{tasks:[],reflection:''},6:{tasks:[],reflection:''}}, hours:{sleep:56,class:15,study:20,work:0} };
  return plannerData[wk];
}

// ── PLANNER INIT ─────────────────────────────────────────────────────────
function initPlanner() {
  loadPlannerData();
  plannerWeekStart = getWeekStart(new Date());
  renderPlanner();
  calcHours();
}

function changeWeek(d) { plannerWeekStart.setDate(plannerWeekStart.getDate() + d*7); renderPlanner(); }
function goThisWeek() { plannerWeekStart = getWeekStart(new Date()); renderPlanner(); }
function setPlannerView(v) {
  plannerView = v;
  document.getElementById('pvGrid').classList.toggle('active', v==='grid');
  document.getElementById('pvTID').classList.toggle('active', v==='tid');
  document.getElementById('plannerGridView').style.display = v==='grid' ? '' : 'none';
  document.getElementById('plannerTIDView').style.display = v==='tid' ? '' : 'none';
  document.getElementById('tidSection').style.display = v==='grid' ? '' : 'none';
}

function calcHours() {
  const sleep = +document.getElementById('hrsSleep').value || 0;
  const cls   = +document.getElementById('hrsClass').value || 0;
  const study = +document.getElementById('hrsStudy').value || 0;
  const work  = +document.getElementById('hrsWork').value || 0;
  const free  = 168 - sleep - cls - study - work;
  const el = document.getElementById('hrsResult');
  el.textContent = `${free} hrs discretionary`;
  el.className = 'hours-result' + (free < 10 ? ' low' : '');
  // save to week
  const wk = weekKey(plannerWeekStart);
  const wd = getWeekData(wk);
  wd.hours = {sleep,class:cls,study,work};
  savePlannerData();
}

// ── RENDER ───────────────────────────────────────────────────────────────
function renderPlanner() {
  const wk = weekKey(plannerWeekStart);
  const wd = getWeekData(wk);
  const today = new Date(); today.setHours(0,0,0,0);

  // Update hour inputs from saved data
  if (wd.hours) {
    document.getElementById('hrsSleep').value = wd.hours.sleep ?? 56;
    document.getElementById('hrsClass').value = wd.hours.class ?? 15;
    document.getElementById('hrsStudy').value = wd.hours.study ?? 20;
    document.getElementById('hrsWork').value  = wd.hours.work ?? 0;
    calcHours();
  }

  // Week label
  const end = new Date(plannerWeekStart); end.setDate(end.getDate()+6);
  document.getElementById('plannerWeekLabel').textContent =
    `${plannerWeekStart.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;

  // Count canvas assignments this week
  const weekAssignments = getWeekAssignments();
  document.getElementById('plannerAssignmentCount').textContent =
    weekAssignments.length ? `${weekAssignments.length} assignment${weekAssignments.length>1?'s':''} due this week` : '';

  // Build grid
  buildGrid(wd, today, weekAssignments);
  // Build TID bottom
  buildTID('tidGridBottom', wd, today, wk);
  // Build TID view (same data, separate element)
  buildTID('tidGrid', wd, today, wk);
}

function getWeekAssignments() {
  if (!allAssignments || !allAssignments.length) return [];
  const results = [];
  for (let d = 0; d < 7; d++) {
    const day = new Date(plannerWeekStart);
    day.setDate(day.getDate() + d);
    const dayStr = day.toDateString();
    allAssignments.forEach(a => {
      if (!a.due_at) return;
      const due = new Date(a.due_at);
      if (due.toDateString() === dayStr) {
        results.push({ ...a, dayIndex: d, slot: Math.max(0, (due.getHours() - HOURS_START) * 2 + Math.floor(due.getMinutes()/30)) });
      }
    });
  }
  return results;
}

function buildGrid(wd, today, weekAssignments) {
  const grid = document.getElementById('plannerGrid');
  const dayDates = Array.from({length:7},(_,i)=>{const d=new Date(plannerWeekStart);d.setDate(d.getDate()+i);return d;});

  let html = `<div class="grid-corner"><span style="font-size:9px;color:var(--muted)">TIME</span></div>`;
  dayDates.forEach((d,i) => {
    const isToday = d.toDateString() === today.toDateString();
    html += `<div class="grid-day-hdr${isToday?' today-col':''}">
      <div class="grid-day-name">${DAYS[i]}</div>
      <div class="grid-day-date">${d.getDate()}</div>
    </div>`;
  });

  // Time slot rows
  for (let s = 0; s < SLOTS; s++) {
    const totalMins = (HOURS_START * 60) + s * 30;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const isHour = m === 0;
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ampm = h >= 12 ? 'pm' : 'am';
    const label = isHour ? `${h12}${ampm}` : '';

    html += `<div class="time-label${isHour?' hour-mark':''}"><span>${label}</span></div>`;

    dayDates.forEach((d,di) => {
      const isToday = d.toDateString() === today.toDateString();
      html += `<div class="grid-cell${isHour?' hour-mark':''}${isToday?' today-col':''}" data-day="${di}" data-slot="${s}" data-cs-onclick="cellClick(${di},${s})"></div>`;
    });
  }

  grid.innerHTML = html;

  // Render user blocks
  wd.blocks.forEach(b => renderBlockInGrid(b));

  // Render canvas assignment blocks
  weekAssignments.forEach(a => {
    if (a.slot < 0 || a.slot >= SLOTS) return;
    renderAssignmentInGrid(a);
  });
}

function slotToCell(dayIndex, slot) {
  // grid has 1 header row: row 0 is headers, rows 1+ are time slots
  // each row has: time-label + 7 cells
  // cell index in the flat grid: header row = 8 items, then each slot row = 8 items
  // day column di = position di+1 in each slot row
  const cellsPerRow = 8;
  const headerCells = 8;
  const rowStart = headerCells + slot * cellsPerRow;
  const cellIdx = rowStart + dayIndex + 1;
  return document.getElementById('plannerGrid').children[cellIdx];
}

function renderBlockInGrid(b) {
  const cell = slotToCell(b.day, b.slot);
  if (!cell) return;
  const existing = cell.querySelector('.cell-block[data-block-id]');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'cell-block';
  div.setAttribute('data-block-id', b.id);
  div.style.background = b.color || '#1a2744';
  div.style.height = `${(b.duration||1)*28 - 3}px`;
  div.style.zIndex = 2;
  const courseName = b.courseId ? (courses.find(c=>c.id==b.courseId)?.course_code || '') : '';
  div.innerHTML = `<div class="cb-title">${b.text||''}</div>${courseName?`<div class="cb-course">${courseName}</div>`:''}`;
  div.onclick = (e) => { e.stopPropagation(); openBlockModal(b.day, b.slot, b); };
  cell.appendChild(div);
}

function renderAssignmentInGrid(a) {
  const cell = slotToCell(a.dayIndex, a.slot);
  if (!cell) return;
  const div = document.createElement('div');
  div.className = 'cell-block';
  div.style.background = a.color || '#3b82f6';
  div.style.height = '25px';
  div.style.opacity = '0.85';
  div.style.zIndex = 1;
  div.innerHTML = `<div class="cb-title">📌 ${a.name}</div>`;
  div.onclick = (e) => { e.stopPropagation(); openEventModal(a.id); };
  cell.appendChild(div);
}

// ── TID CARDS ────────────────────────────────────────────────────────────
function buildTID(elId, wd, today, wk) {
  const grid = document.getElementById(elId);
  if (!grid) return;
  grid.innerHTML = '';
  for (let d = 0; d < 7; d++) {
    const date = new Date(plannerWeekStart); date.setDate(date.getDate() + d);
    const isToday = date.toDateString() === today.toDateString();
    const tid = wd.tid[d] || { tasks: [], reflection: '' };
    const color = isToday ? 'var(--navy)' : '#4a5568';
    const dateStr = date.toLocaleDateString('en-US',{month:'short',day:'numeric'});

    const card = document.createElement('div');
    card.className = 'tid-card';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'tid-card-hdr';
    hdr.style.background = color;
    hdr.innerHTML = `<span>${DAYS[d]}</span><span class="tid-card-date">${dateStr}</span>`;
    card.appendChild(hdr);

    // Tasks
    const tasksEl = document.createElement('div');
    tasksEl.className = 'tid-tasks';
    tasksEl.innerHTML = '<div class="tid-tasks-label">Tasks</div>';

    const taskList = document.createElement('div');
    taskList.id = `tid-tasks-${elId}-${d}`;
    tid.tasks.forEach((t,ti) => {
      taskList.appendChild(buildTaskRow(t, ti, d, elId, wk));
    });
    tasksEl.appendChild(taskList);

    // Add row
    const addRow = document.createElement('div');
    addRow.className = 'tid-add-row';
    addRow.innerHTML = `
      <input class="tid-add-inp" id="tid-inp-${elId}-${d}" placeholder="Add task…" data-cs-onkeydown="if(event.key==='Enter')addTIDTask('${elId}',${d},'${wk}')"/>
      <select class="tid-priority-sel" id="tid-pri-${elId}-${d}">
        <option value="A">A</option><option value="B" selected>B</option><option value="C">C</option>
      </select>
      <button class="tid-add-btn" data-cs-onclick="addTIDTask('${elId}',${d},'${wk}')">+</button>`;
    tasksEl.appendChild(addRow);
    card.appendChild(tasksEl);

    // Reflection
    const refEl = document.createElement('div');
    refEl.className = 'tid-reflection';
    refEl.innerHTML = `<div class="tid-reflection-label">Reflection</div>
      <textarea id="tid-ref-${elId}-${d}" placeholder="What went well? Where did I stray? How can I improve?" data-cs-onchange="saveTIDReflection('${elId}',${d},'${wk}')">${tid.reflection||''}</textarea>`;
    card.appendChild(refEl);

    grid.appendChild(card);
  }
}

function buildTaskRow(task, taskIndex, day, elId, wk) {
  const row = document.createElement('div');
  row.className = 'tid-task-row';
  row.id = `tid-task-${elId}-${day}-${taskIndex}`;
  row.innerHTML = `
    <input type="checkbox" ${task.done?'checked':''} data-cs-onchange="toggleTIDTask('${elId}',${day},${taskIndex},'${wk}')"/>
    <span class="tid-priority ${task.priority}">${task.priority}</span>
    <span class="tid-task-text${task.done?' done':''}" title="${task.text}">${task.text}</span>
    <button data-cs-onclick="deleteTIDTask('${elId}',${day},${taskIndex},'${wk}')" style="background:none;border:none;color:var(--muted2);cursor:pointer;font-size:12px;padding:0 2px;flex-shrink:0" title="Remove">×</button>`;
  return row;
}

function addTIDTask(elId, day, wk) {
  const inp = document.getElementById(`tid-inp-${elId}-${day}`);
  const pri = document.getElementById(`tid-pri-${elId}-${day}`);
  if (!inp || !inp.value.trim()) return;
  const wd = getWeekData(wk);
  wd.tid[day].tasks.push({ text: inp.value.trim(), priority: pri.value, done: false });
  inp.value = '';
  savePlannerData();
  syncTIDGrids(wk);
}

function toggleTIDTask(elId, day, taskIndex, wk) {
  const wd = getWeekData(wk);
  if (wd.tid[day].tasks[taskIndex]) wd.tid[day].tasks[taskIndex].done = !wd.tid[day].tasks[taskIndex].done;
  savePlannerData();
  syncTIDGrids(wk);
}

function deleteTIDTask(elId, day, taskIndex, wk) {
  const wd = getWeekData(wk);
  wd.tid[day].tasks.splice(taskIndex, 1);
  savePlannerData();
  syncTIDGrids(wk);
}

function saveTIDReflection(elId, day, wk) {
  const ta = document.getElementById(`tid-ref-${elId}-${day}`);
  if (!ta) return;
  const wd = getWeekData(wk);
  wd.tid[day].reflection = ta.value;
  savePlannerData();
  // Sync to other TID grid without full rebuild
  const otherId = elId === 'tidGridBottom' ? 'tidGrid' : 'tidGridBottom';
  const otherTa = document.getElementById(`tid-ref-${otherId}-${day}`);
  if (otherTa && otherTa !== ta) otherTa.value = ta.value;
}

function syncTIDGrids(wk) {
  const wd = getWeekData(wk);
  const today = new Date(); today.setHours(0,0,0,0);
  buildTID('tidGridBottom', wd, today, wk);
  if (plannerView === 'tid') buildTID('tidGrid', wd, today, wk);
}

// ── BLOCK EDITOR ─────────────────────────────────────────────────────────
function cellClick(day, slot) {
  openBlockModal(day, slot, null);
}

function openBlockModal(day, slot, existingBlock) {
  editingBlockId = existingBlock ? existingBlock.id : null;
  document.getElementById('blockModalTitle').textContent = existingBlock ? 'Edit Block' : 'Add Time Block';
  document.getElementById('bmDay').value = day;
  document.getElementById('bmSlot').value = slot;
  document.getElementById('bmText').value = existingBlock ? existingBlock.text : '';
  document.getElementById('bmDuration').value = existingBlock ? existingBlock.duration : 2;
  document.getElementById('bmColor').value = existingBlock ? existingBlock.color : '#1a2744';
  document.getElementById('bmDeleteBtn').style.display = existingBlock ? 'block' : 'none';

  // Populate course select
  const sel = document.getElementById('bmCourse');
  sel.innerHTML = '<option value="">— None —</option>';
  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    if (existingBlock?.courseId == c.id) opt.selected = true;
    sel.appendChild(opt);
  });

  // Color presets
  const presets = document.getElementById('bmColorPresets');
  presets.innerHTML = '';
  const presetColors = ['#1a2744','#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316'];
  presetColors.forEach(c => {
    const btn = document.createElement('div');
    btn.style.cssText = `width:20px;height:20px;border-radius:50%;background:${c};cursor:pointer;border:2px solid transparent;transition:border-color 0.1s`;
    btn.onclick = () => { document.getElementById('bmColor').value = c; presets.querySelectorAll('div').forEach(b=>b.style.borderColor='transparent'); btn.style.borderColor='var(--navy)'; };
    if (c === (existingBlock?.color||'#1a2744')) btn.style.borderColor = 'var(--navy)';
    presets.appendChild(btn);
  });

  document.getElementById('blockModalOverlay').classList.add('open');
  setTimeout(()=>document.getElementById('bmText').focus(), 50);
}

function closeBlockModal() { document.getElementById('blockModalOverlay').classList.remove('open'); editingBlockId = null; }
function maybeCloseBlockModal(e) { if (e.target === document.getElementById('blockModalOverlay')) closeBlockModal(); }

function saveBlock() {
  const text = document.getElementById('bmText').value.trim();
  if (!text) { document.getElementById('bmText').focus(); return; }
  const day      = +document.getElementById('bmDay').value;
  const slot     = +document.getElementById('bmSlot').value;
  const duration = +document.getElementById('bmDuration').value;
  const color    = document.getElementById('bmColor').value;
  const courseId = document.getElementById('bmCourse').value;
  const wk       = weekKey(plannerWeekStart);
  const wd       = getWeekData(wk);

  if (editingBlockId) {
    const b = wd.blocks.find(x=>x.id===editingBlockId);
    if (b) { b.text=text; b.duration=duration; b.color=color; b.courseId=courseId; b.day=day; b.slot=slot; }
  } else {
    wd.blocks.push({ id: Date.now()+'', day, slot, duration, text, color, courseId });
  }
  savePlannerData();
  closeBlockModal();
  const weekAssignments = getWeekAssignments();
  buildGrid(wd, new Date(), weekAssignments);
}

function deleteBlock() {
  if (!editingBlockId) return;
  const wk = weekKey(plannerWeekStart);
  const wd = getWeekData(wk);
  wd.blocks = wd.blocks.filter(b=>b.id!==editingBlockId);
  savePlannerData();
  closeBlockModal();
  const weekAssignments = getWeekAssignments();
  buildGrid(wd, new Date(), weekAssignments);
}


// ── AI WEEKLY PLANNER ─────────────────────────────────────────────────────
let aiPlanRunning = false;

function aiPlanWeek() {
  if (!anthropicKey) { alert('Connect to Canvas first to use AI planning.'); return; }
  document.getElementById('aiPlanModal').classList.add('open');
  document.getElementById('aiPlanStatus').style.display = 'none';
}
function closeAIPlanModal() { document.getElementById('aiPlanModal').classList.remove('open'); }

async function runAIPlan() {
  if (aiPlanRunning) return;
  aiPlanRunning = true;
  const btn = document.getElementById('aiPlanGo');
  const status = document.getElementById('aiPlanStatus');
  const userPrompt = document.getElementById('aiPlanPrompt').value.trim();
  const replace = document.getElementById('aiPlanReplace').checked;

  btn.disabled = true;
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="animation:spin 1s linear infinite"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 2a4 4 0 010 8 4 4 0 010-8z" opacity=".3"/><path d="M14 8a6 6 0 01-6 6v-2a4 4 0 000-8V2a6 6 0 016 6z"/></svg> Generating…';
  status.style.display = 'block';
  status.textContent = '⏳ Reading your Canvas assignments…';

  // Build context
  const wk = weekKey(plannerWeekStart);
  const weekEnd = new Date(plannerWeekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const weekStr = `${plannerWeekStart.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})} to ${weekEnd.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}`;

  // Get assignments for this week and next 2 weeks (context)
  const relevant = allAssignments
    .filter(a => a.due_at)
    .sort((a,b) => new Date(a.due_at) - new Date(b.due_at))
    .slice(0, 40)
    .map(a => {
      const d = new Date(a.due_at);
      return `- "${a.name}" | Course: ${a.course_name} | Due: ${d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} | Points: ${a.points_possible||'N/A'} | ${a.submission?.submitted_at ? 'SUBMITTED' : a.submission?.missing ? 'MISSING' : 'Not submitted'}`;
    }).join('\n');

  const courseList = courses.map(c => `- ${c.name} (${c.course_code||''})`).join('\n');

  const systemPrompt = `You are an expert academic planner. You create detailed, realistic weekly study schedules for college students based on their Canvas assignments and personal preferences.

You must respond ONLY with a valid JSON object — no markdown, no explanation, just JSON.

The student's week runs: ${weekStr}
Days are indexed 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
Time slots are indexed from slot 0 = 6:00 AM, incrementing by 30 minutes. Slot 6 = 9:00 AM, slot 12 = noon, slot 18 = 3 PM, slot 24 = 6 PM, slot 30 = 9 PM. Max slot is 33 (11:30 PM).

Courses:
${courseList}

Upcoming assignments (sorted by due date):
${relevant || 'No assignments found.'}

Return this exact JSON format:
{
  "summary": "2-3 sentence plain text overview of the plan you created",
  "blocks": [
    {
      "day": 1,
      "slot": 6,
      "duration": 2,
      "text": "Study Chapter 4 — Biology",
      "color": "#3b82f6",
      "courseId": null
    }
  ],
  "tid": {
    "0": { "tasks": [{"text": "Rest and prepare for the week", "priority": "B"}], "reflection": "" },
    "1": { "tasks": [{"text": "Review lecture notes", "priority": "A"}], "reflection": "" },
    "2": { "tasks": [], "reflection": "" },
    "3": { "tasks": [], "reflection": "" },
    "4": { "tasks": [], "reflection": "" },
    "5": { "tasks": [], "reflection": "" },
    "6": { "tasks": [], "reflection": "" }
  },
  "hours": { "sleep": 56, "class": 15, "study": 20, "work": 0 }
}

RULES:
- blocks: 3-5 hours of study blocks per weekday, less on weekends. Space them out realistically. Include breaks.
- Prioritize assignments due soonest with A priority TID tasks.
- Block colors: use course-appropriate colors. Use blue (#3b82f6) for studying, green (#10b981) for assignments/submissions, amber (#f59e0b) for reviews, purple (#8b5cf6) for reading.
- tid tasks: Each day should have 2-5 tasks. Use A for due assignments, B for study/review, C for optional prep.
- tid tasks should reference specific assignment names when relevant.
- hours: suggest realistic study hours based on the assignment load.
- Do NOT schedule blocks before 7:00 AM (slot 2) or after 10:30 PM (slot 33).
- Respect any student preferences in the user message.
- courseId should always be null (we don't have the IDs in this context).`;

  const userMsg = userPrompt 
    ? `Plan my week. My preferences: ${userPrompt}` 
    : 'Plan my week based on my assignments and a typical college schedule.';

  try {
    status.textContent = '🧠 Claude is building your schedule…';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!res.ok) {
      const e = await res.json().catch(()=>({error:{message:res.statusText}}));
      throw new Error(e.error?.message || res.statusText);
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text || '{}';

    status.textContent = '📋 Applying your schedule…';

    // Parse JSON robustly
    let plan;
    try {
      const cleaned = rawText.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
      const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
      plan = JSON.parse(cleaned.slice(start, end+1));
    } catch(e) {
      throw new Error('Could not parse AI response. Try again.');
    }

    // Apply to planner
    const wd = getWeekData(wk);
    if (replace) wd.blocks = [];

    // Add blocks
    (plan.blocks || []).forEach(b => {
      if (b.day < 0 || b.day > 6) return;
      if (b.slot < 0 || b.slot > 33) return;
      wd.blocks.push({
        id: Date.now() + '-' + Math.random(),
        day: b.day, slot: b.slot,
        duration: Math.max(1, Math.min(8, b.duration || 2)),
        text: b.text || 'Study block',
        color: b.color || '#3b82f6',
        courseId: b.courseId || null
      });
    });

    // Apply TID tasks
    if (plan.tid) {
      for (let d = 0; d < 7; d++) {
        const dayPlan = plan.tid[String(d)];
        if (!dayPlan) continue;
        if (!wd.tid[d]) wd.tid[d] = { tasks: [], reflection: '' };
        if (replace) wd.tid[d].tasks = [];
        (dayPlan.tasks || []).forEach(t => {
          wd.tid[d].tasks.push({ text: t.text, priority: t.priority || 'B', done: false });
        });
        if (dayPlan.reflection) wd.tid[d].reflection = dayPlan.reflection;
      }
    }

    // Apply hours
    if (plan.hours) {
      wd.hours = plan.hours;
      document.getElementById('hrsSleep').value = plan.hours.sleep ?? 56;
      document.getElementById('hrsClass').value = plan.hours.class ?? 15;
      document.getElementById('hrsStudy').value = plan.hours.study ?? 20;
      document.getElementById('hrsWork').value  = plan.hours.work ?? 0;
      calcHours();
    }

    savePlannerData();
    renderPlanner();

    status.style.background = '#ecfdf5';
    status.style.color = '#059669';
    status.textContent = '✓ Schedule created! ' + (plan.summary || '');

    btn.disabled = false;
    btn.innerHTML = '✓ Done — Close';
    btn.onclick = closeAIPlanModal;

  } catch(e) {
    status.style.background = '#fef2f2';
    status.style.color = '#dc2626';
    status.textContent = '✗ Error: ' + e.message;
    btn.disabled = false;
    btn.innerHTML = 'Try Again';
    btn.onclick = runAIPlan;
  }

  aiPlanRunning = false;
}
