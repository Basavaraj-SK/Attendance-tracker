// Application Logic, Sync & Mathematical Engines
let subjects = [];
let logs = [];
let holidays = [];
let config = { globalTarget: 75, audioEnabled: true };
let currentActiveAlert = null;
let promptedSlotsToday = new Set();
let calViewDate = new Date();
let cloudUnsubscribers = [];

const DAYS_MAP = [
  { id: 1, name: 'Monday', short: 'Mon' },
  { id: 2, name: 'Tuesday', short: 'Tue' },
  { id: 3, name: 'Wednesday', short: 'Wed' },
  { id: 4, name: 'Thursday', short: 'Thu' },
  { id: 5, name: 'Friday', short: 'Fri' },
  { id: 6, name: 'Saturday', short: 'Sat' },
  { id: 7, name: 'Sunday', short: 'Sun' }
];

// ==========================================
// 1. DATA INITIALIZATION & SYNC
// ==========================================

function loadUserData() {
  loadFromStorage();
  if (subjects.length === 0) populateStarterData();

  setupCloudSync();

  const today = new Date();
  const filterMonthInput = document.getElementById('filterMonth');
  if (filterMonthInput) {
    filterMonthInput.value = today.toISOString().slice(0, 7);
    filterMonthInput.addEventListener('change', renderAnalyticsTab);
  }

  const globalTargetInput = document.getElementById('globalTargetInput');
  if (globalTargetInput) globalTargetInput.value = config.globalTarget || 75;

  updateAudioIcon();
  renderAgendaTab();
  renderAnalyticsTab();
  renderTimetableTab();
  renderHistoryTab();

  startClockAndChecker();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  checkNotificationBanner();
}

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY_SUBJECTS, JSON.stringify(subjects));
  localStorage.setItem(STORAGE_KEY_LOGS, JSON.stringify(logs));
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
  localStorage.setItem(STORAGE_KEY_HOLIDAYS, JSON.stringify(holidays));
}

function loadFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY_SUBJECTS); if (s) subjects = JSON.parse(s);
    const l = localStorage.getItem(STORAGE_KEY_LOGS); if (l) logs = JSON.parse(l);
    const c = localStorage.getItem(STORAGE_KEY_CONFIG); if (c) config = JSON.parse(c);
    const h = localStorage.getItem(STORAGE_KEY_HOLIDAYS); if (h) holidays = JSON.parse(h);
  } catch (e) {
    console.warn("Storage read note:", e);
  }
}

function clearCloudListeners() {
  cloudUnsubscribers.forEach((u) => { try { u(); } catch (e) {} });
  cloudUnsubscribers = [];
}

function setupCloudSync() {
  if (!isCloudReady || !currentUser) return;
  clearCloudListeners();

  const userRef = db.collection("users").doc(currentUser.uid);

  // Sync isolated user subjects
  const unsubSubjects = userRef.collection("user_data").doc("subjects").onSnapshot((doc) => {
    if (doc.exists && Array.isArray(doc.data().list)) {
      subjects = doc.data().list;
      saveToStorage();
      renderAgendaTab();
      renderAnalyticsTab();
      renderTimetableTab();
    } else if (subjects.length > 0) {
      syncSubjectsToCloud();
    }
  }, err => console.warn("User subjects sync note:", err));
  cloudUnsubscribers.push(unsubSubjects);

  // Sync isolated attendance records
  const unsubLogs = userRef.collection("attendance_logs").onSnapshot((snapshot) => {
    logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    saveToStorage();
    renderAgendaTab();
    renderAnalyticsTab();
    renderHistoryTab();
    renderCalendarPopover();
  }, err => console.warn("User logs sync note:", err));
  cloudUnsubscribers.push(unsubLogs);

  // Sync isolated holidays
  const unsubHolidays = userRef.collection("user_data").doc("holidays").onSnapshot((doc) => {
    if (doc.exists && Array.isArray(doc.data().dates)) {
      holidays = doc.data().dates;
      saveToStorage();
      renderAgendaTab();
      renderCalendarPopover();
    }
  }, err => console.warn("User holidays sync note:", err));
  cloudUnsubscribers.push(unsubHolidays);
}

async function syncSubjectsToCloud() {
  saveToStorage();
  if (!currentUser) return;
  try {
    await db.collection("users").doc(currentUser.uid).collection("user_data").doc("subjects").set({ list: subjects });
  } catch (e) {
    console.error("Subject cloud sync failed:", e);
  }
}

async function syncHolidaysToCloud() {
  saveToStorage();
  if (!currentUser) return;
  try {
    await db.collection("users").doc(currentUser.uid).collection("user_data").doc("holidays").set({ dates: holidays });
  } catch (e) {
    console.error("Holiday cloud sync failed:", e);
  }
}

// ==========================================
// 2. MATHEMATICAL & TIME CALCULATORS
// ==========================================

function timeToMinutes(tStr) {
  if (!tStr) return 0;
  const [h, m] = tStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const formattedHour = hours % 12 || 12;
  return `${formattedHour}:${minutes < 10 ? '0' + minutes : minutes} ${period}`;
}

function formatMonthYear(ymStr) {
  if (!ymStr) return '';
  const [year, month] = ymStr.split('-');
  return new Date(year, month - 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function calculateAttendanceMath(attended, bunked, targetPct) {
  const totalHeld = attended + bunked;
  const P = (targetPct || 75) / 100;

  if (totalHeld === 0) {
    return {
      attended: 0, bunked: 0, totalHeld: 0, percentage: 100, canBunk: 0, needToAttend: 0,
      status: 'SAFE', label: 'No classes held yet this month'
    };
  }

  const fraction = attended / totalHeld;
  const percentage = Math.round(fraction * 1000) / 10;
  let canBunk = 0, needToAttend = 0, status = 'SAFE', label = '';

  if (fraction >= P) {
    canBunk = Math.floor(attended / P - totalHeld);
    status = canBunk > 0 ? 'SAFE' : 'WARNING';
    label = canBunk > 0 ? `Safe: Can bunk ${canBunk} more lecture${canBunk > 1 ? 's' : ''}` : 'On the edge: Do not miss next lecture!';
  } else {
    needToAttend = Math.ceil((P * totalHeld - attended) / (1 - P));
    status = 'CRITICAL';
    label = `Shortage: Must attend next ${needToAttend} class${needToAttend > 1 ? 'es' : ''} consecutively`;
  }

  return { attended, bunked, totalHeld, percentage, canBunk, needToAttend, status, label };
}

// ==========================================
// 3. UI RENDERING ENGINES
// ==========================================

function toggleTodayHoliday() {
  const todayStr = new Date().toISOString().split('T')[0];
  if (holidays.includes(todayStr)) {
    holidays = holidays.filter(d => d !== todayStr);
    showToast(`Removed holiday for today.`);
  } else {
    holidays.push(todayStr);
    showToast(`Marked today as full-day holiday! 🎉`);
  }
  syncHolidaysToCloud();
  renderAgendaTab();
  renderCalendarPopover();
}

function renderAgendaTab() {
  const today = new Date();
  let dayOfWeek = today.getDay(); if (dayOfWeek === 0) dayOfWeek = 7;
  const dateStr = today.toISOString().split('T')[0];
  const curMins = today.getHours() * 60 + today.getMinutes();
  const isHoliday = holidays.includes(dateStr);

  document.getElementById('currentDayBadge').innerText = DAYS_MAP.find(d => d.id === dayOfWeek)?.name || 'Today';
  document.getElementById('currentDateFull').innerText = today.toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
  });

  const holidayBadge = document.getElementById('todayHolidayBadge');
  const holBtn = document.getElementById('todayHolidayBtn');
  holidayBadge.classList.toggle('hidden', !isHoliday);

  holBtn.className = isHoliday
    ? 'px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-500 text-white flex items-center gap-1.5 shadow-xs'
    : 'px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-200 flex items-center gap-1.5 hover:bg-slate-50 text-slate-700 shadow-xs';
  holBtn.innerHTML = `<i data-lucide="${isHoliday ? 'check' : 'sun'}" class="w-3.5 h-3.5 pointer-events-none"></i> <span>${isHoliday ? 'Holiday Active' : 'Mark Holiday'}</span>`;

  const container = document.getElementById('todayCardsContainer');

  if (isHoliday) {
    container.innerHTML = `
      <div class="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent rounded-2xl border border-amber-200 p-6 sm:p-8 text-center">
        <h4 class="font-bold text-slate-900 text-base sm:text-lg">Institute Holiday Active!</h4>
        <p class="text-xs text-slate-600 mt-1">Scheduled lectures and reminder prompts are paused today without affecting your stats.</p>
        <button onclick="toggleTodayHoliday()" class="mt-4 px-4 py-2 text-xs font-bold bg-white text-slate-700 border border-slate-200 rounded-xl hover:bg-slate-50 shadow-xs">
          Revoke Holiday & Show Routine
        </button>
      </div>
    `;
    document.getElementById('todayTotalCount').innerText = '0';
    document.getElementById('todayAttendedCount').innerText = '0';
    document.getElementById('todayBunkedCount').innerText = '0';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const todaySlots = [];
  subjects.forEach(sub => (sub.slots || []).forEach(slot => {
    if (parseInt(slot.dayOfWeek) === dayOfWeek) todaySlots.push({ sub, slot });
  }));
  todaySlots.sort((a, b) => a.slot.startTime.localeCompare(b.slot.startTime));

  if (todaySlots.length === 0) {
    container.innerHTML = `<p class="text-center text-xs text-slate-400 py-8 bg-white rounded-2xl border border-slate-200">No classes scheduled today.</p>`;
    document.getElementById('todayTotalCount').innerText = '0';
    document.getElementById('todayAttendedCount').innerText = '0';
    document.getElementById('todayBunkedCount').innerText = '0';
    return;
  }

  let attended = 0, bunked = 0;
  container.innerHTML = todaySlots.map(({ sub, slot }) => {
    const log = logs.find(l => l.subjectId === sub.id && l.date === dateStr && l.time === slot.startTime);
    if (log?.status === 'ATTENDED') attended++;
    if (log?.status === 'BUNKED') bunked++;

    const sMin = timeToMinutes(slot.startTime);
    const eMin = timeToMinutes(slot.endTime);
    const isUpcoming = curMins < sMin;
    const isActive = curMins >= sMin && curMins <= eMin;

    let actions = '';
    if (log) {
      actions = `<span class="px-3 py-1.5 rounded-xl text-xs font-bold ${log.status === 'ATTENDED' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${log.status}</span>`;
    } else if (isUpcoming) {
      actions = `<span class="text-xs text-slate-400 flex items-center gap-1 font-mono"><i data-lucide="lock" class="w-3.5 h-3.5"></i> Starts ${formatTime(slot.startTime)}</span>`;
    } else if (isActive) {
      actions = `
        <div class="flex gap-1.5 w-full sm:w-auto">
          <button onclick="recordAttendance('${sub.id}', '${dateStr}', '${slot.startTime}', 'BUNKED')" class="flex-1 sm:flex-initial px-3 py-2 border border-rose-200 text-rose-700 font-bold rounded-xl text-xs hover:bg-rose-50 transition active:scale-95">Absent</button>
          <button onclick="recordAttendance('${sub.id}', '${dateStr}', '${slot.startTime}', 'ATTENDED')" class="flex-1 sm:flex-initial px-3.5 py-2 bg-emerald-600 text-white font-bold rounded-xl text-xs hover:bg-emerald-700 transition active:scale-95 shadow-xs">Present</button>
        </div>
      `;
    } else {
      actions = `<button onclick="recordAttendance('${sub.id}', '${dateStr}', '${slot.startTime}', 'ATTENDED')" class="text-xs text-indigo-600 font-bold hover:underline">Late Mark?</button>`;
    }

    return `
      <div class="bg-white rounded-2xl border ${isActive ? 'border-indigo-400 ring-2 ring-indigo-50 shadow-sm' : 'border-slate-200'} p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="font-bold text-slate-900 truncate">${escapeHtml(sub.name)}</h3>
            <span class="text-xs px-2 py-0.5 rounded bg-slate-100 font-mono font-bold text-slate-600">${escapeHtml(sub.code)}</span>
            ${isActive ? '<span class="px-2 py-0.5 rounded-full text-[9px] bg-emerald-500 text-white font-extrabold uppercase animate-pulse">Live</span>' : ''}
          </div>
          <p class="text-xs text-slate-500 mt-1 truncate">${escapeHtml(sub.profName || 'Faculty')} • Room: ${escapeHtml(sub.room || 'N/A')} • <span class="font-mono text-slate-700 font-bold">${formatTime(slot.startTime)} - ${formatTime(slot.endTime)}</span></p>
        </div>
        ${actions}
      </div>
    `;
  }).join('');

  document.getElementById('todayTotalCount').innerText = todaySlots.length;
  document.getElementById('todayAttendedCount').innerText = attended;
  document.getElementById('todayBunkedCount').innerText = bunked;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function recordAttendance(subjectId, date, time, status) {
  const cleanTime = (time || '00:00').replace(/[^a-zA-Z0-9]/g, '');
  const docId = `${subjectId}_${date}_${cleanTime}`;

  logs = logs.filter(l => !(l.subjectId === subjectId && l.date === date && l.time === time));
  logs.push({ id: docId, subjectId, date, time, status, createdAt: Date.now() });

  saveToStorage();
  renderAgendaTab();
  renderAnalyticsTab();
  renderHistoryTab();

  if (currentUser) {
    try {
      await db.collection("users").doc(currentUser.uid).collection("attendance_logs").doc(docId).set({
        subjectId, date, time, status, createdAt: Date.now()
      });
    } catch (e) {
      console.error("Firestore attendance write error:", e);
    }
  }
  showToast(status === 'ATTENDED' ? '✅ Marked Present!' : '❌ Marked Absent.');
}

function renderAnalyticsTab() {
  const monthInput = document.getElementById('filterMonth');
  const month = monthInput ? monthInput.value : new Date().toISOString().slice(0, 7);
  const targetPct = config.globalTarget || 75;

  const mLogs = logs.filter(l => l.date && l.date.startsWith(month));
  let att = 0, bnk = 0;
  mLogs.forEach(l => {
    if (l.status === 'ATTENDED') att++;
    if (l.status === 'BUNKED') bnk++;
  });

  const stats = calculateAttendanceMath(att, bnk, targetPct);
  document.getElementById('metricOverallPct').innerText = `${stats.percentage}%`;
  document.getElementById('metricTargetCompare').innerText = `Goal: ${targetPct}%`;
  document.getElementById('metricProgressBar').style.width = `${Math.min(stats.percentage, 100)}%`;
  document.getElementById('metricAttendedTotal').innerText = stats.attended;
  document.getElementById('metricTotalHeld').innerText = `${stats.totalHeld} classes held`;
  document.getElementById('metricBunkedTotal').innerText = stats.bunked;

  const vEl = document.getElementById('metricBunkVerdict');
  if (stats.status === 'SAFE') {
    vEl.innerText = stats.canBunk > 0 ? `Can bunk ${stats.canBunk} more` : 'Right on target';
    vEl.className = 'text-base sm:text-lg font-bold text-emerald-600';
  } else if (stats.status === 'WARNING') {
    vEl.innerText = '0 Safe Bunks left';
    vEl.className = 'text-base sm:text-lg font-bold text-amber-600';
  } else {
    vEl.innerText = `Attend next ${stats.needToAttend} classes`;
    vEl.className = 'text-base sm:text-lg font-bold text-rose-600';
  }

  const list = document.getElementById('subjectAnalyticsList');
  if (subjects.length === 0) {
    list.innerHTML = `<p class="col-span-2 text-center text-xs text-slate-400 py-6">No subjects added.</p>`;
    return;
  }

  list.innerHTML = subjects.map(sub => {
    const sLogs = mLogs.filter(l => l.subjectId === sub.id);
    let sAtt = 0, sBnk = 0;
    sLogs.forEach(l => {
      if (l.status === 'ATTENDED') sAtt++;
      if (l.status === 'BUNKED') sBnk++;
    });
    const subTarget = sub.targetPercentage || targetPct;
    const sStats = calculateAttendanceMath(sAtt, sBnk, subTarget);

    return `
      <div class="border border-slate-200 rounded-2xl p-3.5 bg-slate-50/50 hover:bg-white transition shadow-xs">
        <div class="flex justify-between items-start gap-2">
          <div class="min-w-0">
            <h4 class="font-bold text-slate-900 truncate">${escapeHtml(sub.name)}</h4>
            <span class="text-xs font-mono font-bold text-slate-500">${escapeHtml(sub.code)}</span>
          </div>
          <span class="px-2 py-0.5 text-xs font-bold rounded-xl border shrink-0 ${sStats.status === 'SAFE' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
            ${sStats.percentage}%
          </span>
        </div>
        <div class="w-full bg-slate-200 rounded-full h-1.5 mt-2.5 overflow-hidden">
          <div class="${sStats.status === 'SAFE' ? 'bg-emerald-500' : 'bg-rose-500'} h-full rounded-full transition-all" style="width: ${Math.min(sStats.percentage, 100)}%"></div>
        </div>
        <div class="flex justify-between text-[11px] text-slate-500 mt-2 font-medium">
          <span>Attended: <b>${sStats.attended}</b>/${sStats.totalHeld}</span>
          <span>Bunks: <b class="text-rose-600">${sStats.bunked}</b></span>
          <span>Req: <b>${subTarget}%</b></span>
        </div>
        <div class="mt-2 text-[11px] p-2 rounded-xl border ${sStats.status === 'SAFE' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-rose-50 text-rose-800 border-rose-200'}">
          ${sStats.label}
        </div>
      </div>
    `;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderTimetableTab() {
  const grid = document.getElementById('weeklyGridContainer');
  grid.innerHTML = DAYS_MAP.map(day => {
    const slots = [];
    subjects.forEach(sub => (sub.slots || []).forEach(slot => {
      if (parseInt(slot.dayOfWeek) === day.id) slots.push({ sub, slot });
    }));
    slots.sort((a, b) => a.slot.startTime.localeCompare(b.slot.startTime));

    return `
      <div class="bg-slate-50 rounded-xl border border-slate-200 p-2 flex flex-col">
        <div class="border-b border-slate-200 pb-1 mb-1.5 text-center text-[10px] font-bold uppercase text-slate-700">${day.short}</div>
        <div class="space-y-1.5 flex-1">
          ${slots.length === 0 ? '<p class="text-[9px] text-slate-400 text-center py-3">Free</p>' : ''}
          ${slots.map(({ sub, slot }) => `
            <div class="bg-white rounded-lg p-1.5 border border-slate-200 text-xs shadow-xs">
              <div class="font-bold truncate text-[11px]" title="${escapeHtml(sub.name)}">${escapeHtml(sub.code)}</div>
              <div class="text-[9px] text-indigo-600 font-mono">${formatTime(slot.startTime)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  const list = document.getElementById('subjectsDirectoryList');
  if (subjects.length === 0) {
    list.innerHTML = `<p class="text-xs text-slate-400 text-center py-6">No subjects registered yet.</p>`;
    return;
  }

  list.innerHTML = subjects.map(sub => `
    <div class="py-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
      <div class="min-w-0">
        <h4 class="font-bold text-slate-900 text-sm truncate">${escapeHtml(sub.name)} <span class="font-mono text-slate-500 font-normal">(${escapeHtml(sub.code)})</span></h4>
        <p class="text-xs text-slate-500 mt-0.5 truncate">Prof: ${escapeHtml(sub.profName || 'Faculty')} • Room: ${escapeHtml(sub.room || 'N/A')} • Target: ${sub.targetPercentage || 75}%</p>
      </div>
      <div class="flex gap-2 shrink-0">
        <button onclick="editSubject('${sub.id}')" class="text-xs px-2.5 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 font-medium">Edit</button>
        <button onclick="deleteSubject('${sub.id}')" class="text-xs px-2.5 py-1 border border-rose-200 text-rose-600 rounded-lg hover:bg-rose-50 font-medium">Delete</button>
      </div>
    </div>
  `).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openSubjectModal(editId = null) {
  const form = document.getElementById('subjectForm');
  form.reset();
  document.getElementById('slotsContainer').innerHTML = '';

  if (editId) {
    const sub = subjects.find(s => s.id === editId);
    if (sub) {
      document.getElementById('subjectModalTitle').innerText = 'Edit Subject';
      document.getElementById('subFormId').value = sub.id;
      document.getElementById('subFormName').value = sub.name;
      document.getElementById('subFormCode').value = sub.code;
      document.getElementById('subFormProfName').value = sub.profName || '';
      document.getElementById('subFormRoom').value = sub.room || '';
      document.getElementById('subFormTarget').value = sub.targetPercentage || 75;
      (sub.slots || []).forEach(slot => addSlotRow(slot));
    }
  } else {
    document.getElementById('subjectModalTitle').innerText = 'Add Subject';
    document.getElementById('subFormId').value = '';
    addSlotRow({ dayOfWeek: 1, startTime: '09:00', endTime: '10:00' });
  }

  document.getElementById('subjectModal').classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeSubjectModal() {
  document.getElementById('subjectModal').classList.add('hidden');
}

function addSlotRow(d = null) {
  const container = document.getElementById('slotsContainer');
  const id = 'slotRow_' + Date.now() + Math.random().toString(36).substr(2, 4);
  const row = document.createElement('div');
  row.id = id;
  row.className = 'flex items-center gap-1.5 p-2 bg-slate-50 rounded-xl border border-slate-200 text-xs';
  row.innerHTML = `
    <select class="slot-day bg-white border border-slate-300 rounded-lg px-1.5 py-1 font-semibold text-xs">
      ${DAYS_MAP.map(day => `<option value="${day.id}" ${d && parseInt(d.dayOfWeek) === day.id ? 'selected' : ''}>${day.short}</option>`).join('')}
    </select>
    <input type="time" class="slot-start bg-white border border-slate-300 rounded px-1.5 py-1 text-xs" value="${d ? d.startTime : '09:00'}" required />
    <span class="text-slate-400 text-[10px]">to</span>
    <input type="time" class="slot-end bg-white border border-slate-300 rounded px-1.5 py-1 text-xs" value="${d ? d.endTime : '10:00'}" required />
    <button type="button" onclick="document.getElementById('${id}').remove()" class="text-slate-400 hover:text-rose-600 ml-auto p-1"><i data-lucide="x" class="w-3.5 h-3.5 pointer-events-none"></i></button>
  `;
  container.appendChild(row);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function saveSubject(e) {
  e.preventDefault();
  const id = document.getElementById('subFormId').value;
  const name = document.getElementById('subFormName').value.trim();
  const code = document.getElementById('subFormCode').value.trim().toUpperCase();
  const profName = document.getElementById('subFormProfName').value.trim();
  const room = document.getElementById('subFormRoom').value.trim();
  const targetPercentage = parseFloat(document.getElementById('subFormTarget').value) || 75;

  const slots = [];
  document.querySelectorAll('#slotsContainer > div').forEach((el, idx) => {
    slots.push({
      id: `slot_${Date.now()}_${idx}`,
      dayOfWeek: parseInt(el.querySelector('.slot-day').value),
      startTime: el.querySelector('.slot-start').value,
      endTime: el.querySelector('.slot-end').value
    });
  });

  if (id) {
    const idx = subjects.findIndex(s => s.id === id);
    if (idx !== -1) subjects[idx] = { ...subjects[idx], name, code, profName, room, targetPercentage, slots };
  } else {
    subjects.push({ id: 'sub_' + Date.now(), name, code, profName, room, targetPercentage, slots });
  }

  syncSubjectsToCloud();
  closeSubjectModal();
  renderAgendaTab();
  renderAnalyticsTab();
  renderTimetableTab();
}

function editSubject(id) { openSubjectModal(id); }

function deleteSubject(id) {
  if (confirm("Remove this subject from schedule?")) {
    subjects = subjects.filter(s => s.id !== id);
    syncSubjectsToCloud();
    renderAgendaTab();
    renderAnalyticsTab();
    renderTimetableTab();
  }
}

// ==========================================
// 4. HISTORY LOGS & EXPORTING
// ==========================================

function renderHistoryTab() {
  const tbody = document.getElementById('historyTableBody');
  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 text-xs text-slate-400">No attendance logs found.</td></tr>`;
    return;
  }

  const sorted = [...logs].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  tbody.innerHTML = sorted.map(l => {
    const sub = subjects.find(s => s.id === l.subjectId) || { name: 'Unknown Subject', code: 'N/A' };
    return `
      <tr class="hover:bg-slate-50 text-xs transition">
        <td class="px-3 py-2 font-medium">${l.date}</td>
        <td class="px-3 py-2 font-bold">${escapeHtml(sub.name)}</td>
        <td class="px-3 py-2 font-mono">${l.time ? formatTime(l.time) : 'General'}</td>
        <td class="px-3 py-2"><span class="px-2 py-0.5 rounded-full font-bold text-[10px] ${l.status === 'ATTENDED' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${l.status}</span></td>
        <td class="px-3 py-2 text-right">
          <button onclick="deleteLog('${l.id}')" class="text-slate-400 hover:text-rose-600 transition p-1"><i data-lucide="trash" class="w-3.5 h-3.5 pointer-events-none"></i></button>
        </td>
      </tr>
    `;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function deleteLog(id) {
  logs = logs.filter(l => l.id !== id);
  saveToStorage();
  renderAgendaTab();
  renderAnalyticsTab();
  renderHistoryTab();
  if (currentUser) {
    try {
      await db.collection("users").doc(currentUser.uid).collection("attendance_logs").doc(id).delete();
    } catch (e) {
      console.error("Firestore delete error:", e);
    }
  }
}

async function clearAllLogsConfirmation() {
  if (confirm("Reset all recorded attendance logs?")) {
    logs = [];
    saveToStorage();
    renderAgendaTab();
    renderAnalyticsTab();
    renderHistoryTab();
    if (currentUser) {
      const snap = await db.collection("users").doc(currentUser.uid).collection("attendance_logs").get();
      snap.forEach(d => d.ref.delete());
    }
    showToast("All logs cleared.");
  }
}

function exportLogsToCSV() {
  if (logs.length === 0) return alert("No logs available to export.");
  let csv = "data:text/csv;charset=utf-8,Date,Subject,Code,Time,Status\n";
  logs.forEach(l => {
    const sub = subjects.find(s => s.id === l.subjectId) || { name: 'Unknown', code: 'N/A' };
    csv += `${l.date},"${sub.name}",${sub.code},${l.time || 'General'},${l.status}\n`;
  });
  const link = document.createElement("a");
  link.setAttribute("href", encodeURI(csv));
  link.setAttribute("download", `attendance_logs_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ==========================================
// 5. PERIOD CHECKER, AUDIO & CALENDAR POPOVER
// ==========================================

function startClockAndChecker() {
  let lastMin = '';
  setInterval(() => {
    const now = new Date();
    const clock = document.getElementById('liveClock');
    if (clock) clock.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const curMin = now.toTimeString().slice(0, 5);
    let d = now.getDay(); if (d === 0) d = 7;
    const today = now.toISOString().split('T')[0];

    if (curMin !== lastMin) {
      lastMin = curMin;
      renderAgendaTab();

      if (!holidays.includes(today)) {
        subjects.forEach(sub => (sub.slots || []).forEach(slot => {
          if (parseInt(slot.dayOfWeek) === d && slot.startTime === curMin) {
            const key = `${today}_${sub.id}_${slot.startTime}`;
            const marked = logs.some(l => l.subjectId === sub.id && l.date === today && l.time === slot.startTime);
            if (!marked && !promptedSlotsToday.has(key)) {
              promptedSlotsToday.add(key);
              triggerPeriodAlertModal(sub, slot);
            }
          }
        }));
      }
    }
  }, 1000);
}

function triggerPeriodAlertModal(sub, slot) {
  playChime();
  document.getElementById('alertSubjectName').innerText = sub.name;
  document.getElementById('alertSubjectDetails').innerText = `${sub.code} • Prof: ${sub.profName || 'Faculty'}`;
  document.getElementById('alertSlotTime').innerText = `${formatTime(slot.startTime)} - ${formatTime(slot.endTime)}`;

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('alertPresentBtn').onclick = () => {
    recordAttendance(sub.id, today, slot.startTime, 'ATTENDED');
    dismissPeriodAlert();
  };
  document.getElementById('alertBunkBtn').onclick = () => {
    recordAttendance(sub.id, today, slot.startTime, 'BUNKED');
    dismissPeriodAlert();
  };
  document.getElementById('alertCancelledBtn').onclick = () => {
    dismissPeriodAlert();
  };

  document.getElementById('periodAlertModal').classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function dismissPeriodAlert() {
  document.getElementById('periodAlertModal').classList.add('hidden');
}

function playChime() {
  if (!config.audioEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(523.25, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

function toggleAudio() {
  config.audioEnabled = !config.audioEnabled;
  saveToStorage();
  updateAudioIcon();
  showToast(config.audioEnabled ? "Sound enabled" : "Sound muted");
}

function updateAudioIcon() {
  const i = document.getElementById('audioIcon');
  if (i && typeof lucide !== 'undefined') {
    i.setAttribute('data-lucide', config.audioEnabled ? 'volume-2' : 'volume-x');
    lucide.createIcons();
  }
}

function toggleCalendarPopover(e) {
  if (e) e.stopPropagation();
  const p = document.getElementById('calendarPopover');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) renderCalendarPopover();
}

function closeCalendarPopover() {
  document.getElementById('calendarPopover').classList.add('hidden');
}

function navCalMonth(offset, e) {
  if (e) e.stopPropagation();
  calViewDate.setMonth(calViewDate.getMonth() + offset);
  renderCalendarPopover();
}

function renderCalendarPopover() {
  const y = calViewDate.getFullYear();
  const m = calViewDate.getMonth();
  const mNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  document.getElementById('popoverMonthYear').innerText = `${mNames[m]} ${y}`;

  const fDay = new Date(y, m, 1).getDay();
  const tDays = new Date(y, m + 1, 0).getDate();
  const today = new Date().toISOString().split('T')[0];
  const grid = document.getElementById('popoverCalendarGrid');
  grid.innerHTML = '';

  for (let i = 0; i < fDay; i++) grid.innerHTML += `<div class="p-1"></div>`;

  for (let d = 1; d <= tDays; d++) {
    const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dLogs = logs.filter(l => l.date === dStr);
    const hasAtt = dLogs.some(l => l.status === 'ATTENDED');
    const hasBunk = dLogs.some(l => l.status === 'BUNKED');
    const isHol = holidays.includes(dStr);
    const isTod = dStr === today;

    let dot = '';
    if (isHol) dot = `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 block mx-auto mt-0.5"></span>`;
    else if (hasAtt && hasBunk) dot = `<div class="flex justify-center gap-0.5 mt-0.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span></div>`;
    else if (hasAtt) dot = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 block mx-auto mt-0.5"></span>`;
    else if (hasBunk) dot = `<span class="w-1.5 h-1.5 rounded-full bg-rose-500 block mx-auto mt-0.5"></span>`;

    grid.innerHTML += `
      <button onclick="inspectCalDay('${dStr}', event)" class="p-1 rounded text-center hover:bg-slate-100 ${isTod ? 'border border-indigo-500 font-bold text-indigo-700' : isHol ? 'bg-amber-50 font-bold text-amber-900' : ''}">
        <span>${d}</span>${dot}
      </button>
    `;
  }
}

function inspectCalDay(dStr, e) {
  if (e) e.stopPropagation();
  const box = document.getElementById('popoverDayDetails');
  document.getElementById('popoverSelectedDateTitle').innerText = dStr;
  const dLogs = logs.filter(l => l.date === dStr);
  const isHol = holidays.includes(dStr);

  const list = document.getElementById('popoverDayLogsList');
  const actionBtn = document.getElementById('popoverHolidayActionBtn');

  if (isHol) {
    document.getElementById('popoverSelectedSummary').innerText = "Holiday";
    list.innerHTML = `<p class="text-xs text-amber-700 p-2 bg-amber-50 rounded">Full-day holiday marked.</p>`;
    actionBtn.innerText = "Remove Holiday";
    actionBtn.onclick = () => {
      holidays = holidays.filter(d => d !== dStr);
      syncHolidaysToCloud();
      inspectCalDay(dStr, null);
    };
  } else {
    document.getElementById('popoverSelectedSummary').innerText = `${dLogs.filter(l => l.status === 'ATTENDED').length} Attended`;
    list.innerHTML = dLogs.map(l => {
      const sub = subjects.find(s => s.id === l.subjectId) || { name: 'Subject', code: '' };
      return `<div class="p-1.5 rounded bg-slate-50 border text-[11px] flex justify-between font-bold"><span>${escapeHtml(sub.name)}</span><span class="${l.status === 'ATTENDED' ? 'text-emerald-600' : 'text-rose-600'}">${l.status}</span></div>`;
    }).join('') || '<p class="text-slate-400 text-xs italic">No records.</p>';

    actionBtn.innerText = "Mark as Holiday";
    actionBtn.onclick = () => {
      holidays.push(dStr);
      syncHolidaysToCloud();
      inspectCalDay(dStr, null);
    };
  }
  box.classList.remove('hidden');
}

document.addEventListener('click', (e) => {
  const p = document.getElementById('calendarPopover');
  const b = document.getElementById('calendarToggleBtn');
  if (p && !p.classList.contains('hidden') && !p.contains(e.target) && !b.contains(e.target)) closeCalendarPopover();
});

// ==========================================
// 6. NAVIGATION & TAB SWITCHING
// ==========================================

function switchTab(name) {
  // 1. Hide all main sections
  document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));

  // 2. Reveal the selected tab view
  const targetView = document.getElementById(`view-${name}`);
  if (targetView) targetView.classList.remove('hidden');

  // 3. Reset Desktop Navigation Highlights
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('border-indigo-600', 'text-indigo-600', 'font-semibold');
    b.classList.add('border-transparent', 'text-slate-500');
  });

  const activeDesktopBtn = document.getElementById(`tab-${name}`);
  if (activeDesktopBtn) {
    activeDesktopBtn.classList.add('border-indigo-600', 'text-indigo-600', 'font-semibold');
    activeDesktopBtn.classList.remove('border-transparent', 'text-slate-500');
  }

  // 4. Reset Mobile Bottom Navigation Highlights
  document.querySelectorAll('.mobile-tab-btn').forEach(b => {
    b.classList.remove('text-indigo-600', 'font-bold');
    b.classList.add('text-slate-400', 'font-medium');
  });

  const activeMobileBtn = document.getElementById(`m-tab-${name}`);
  if (activeMobileBtn) {
    activeMobileBtn.classList.add('text-indigo-600', 'font-bold');
    activeMobileBtn.classList.remove('text-slate-400', 'font-medium');
  }

  // 5. Scroll to top on mobile tab change
  window.scrollTo({ top: 0, behavior: 'instant' });

  // 6. Refresh active tab content
  if (name === 'agenda' && typeof renderAgendaTab === 'function') renderAgendaTab();
  if (name === 'analytics' && typeof renderAnalyticsTab === 'function') renderAnalyticsTab();
  if (name === 'timetable' && typeof renderTimetableTab === 'function') renderTimetableTab();
  if (name === 'history' && typeof renderHistoryTab === 'function') renderHistoryTab();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateGlobalTarget() {
  const v = parseFloat(document.getElementById('globalTargetInput').value);
  if (v >= 1 && v <= 100) {
    config.globalTarget = v;
    saveToStorage();
    renderAnalyticsTab();
    showToast(`Target set to ${v}%`);
  }
}

function checkNotificationBanner() {
  if ('Notification' in window && Notification.permission === 'default') {
    const banner = document.getElementById('notifBanner');
    if (banner) banner.classList.remove('hidden');
  }
}

function requestNotificationPermission() {
  if ('Notification' in window) {
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        showToast('Notifications allowed!');
        const banner = document.getElementById('notifBanner');
        if (banner) banner.classList.add('hidden');
      }
    });
  }
}

let toastTimeout;
function showToast(msg) {
  const t = document.getElementById('toastMessage');
  document.getElementById('toastText').innerText = msg;
  t.classList.remove('translate-y-24', 'opacity-0');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.add('translate-y-24', 'opacity-0'), 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function populateStarterData() {
  const now = new Date();
  let d = now.getDay(); if (d === 0) d = 7;
  const curH = String(now.getHours()).padStart(2, '0');
  const nxtH = String((now.getHours() + 1) % 24).padStart(2, '0');

  subjects = [
    {
      id: 'sub_cs301', name: 'Operating Systems', code: 'CS301', profName: 'Dr. A. Sharma', room: 'Hall 3B', targetPercentage: 75,
      slots: [{ id: 'slot_1', dayOfWeek: d, startTime: `${curH}:00`, endTime: `${nxtH}:00` }, { id: 'slot_2', dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }]
    },
    {
      id: 'sub_cs302', name: 'Computer Networks', code: 'CS302', profName: 'Prof. R. Mehta', room: 'Lab 2', targetPercentage: 75,
      slots: [{ id: 'slot_3', dayOfWeek: 2, startTime: '10:00', endTime: '11:00' }]
    }
  ];
  saveToStorage();
}

window.onload = () => {
  initAuth();
};