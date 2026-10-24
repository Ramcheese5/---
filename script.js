/* ============================================================
   Экспресс-ДЗ — логика сайта
   ------------------------------------------------------------
   Сайт сам определяет дату и номер из имени файла.
   Никаких батников, серверов и кнопок — просто открой index.html.

   Имена файлов (оба варианта работают):
     01122026(1).png  → 01.12.2026, №1
     220920261.png    → 22.09.2026, №1
     можно и без расширения: 01122026(1)

   Как сайт находит фото (когда открыт как обычный файл):
   браузер не даёт веб-странице читать список файлов папки,
   поэтому сайт сам перебирает имена по шаблону «дата+номер»
   и показывает те, что реально существуют. Проверяются:
     — даты учебного года (1 сентября — 30 июня) плюс ±45 дней
       вокруг сегодняшней;
     — номера от 1 до 15;
     — расширения (нет), .png, .jpg, .jpeg, .webp.
   Найденные фото появляются по мере поиска, поэтому первые
   карточки видны уже через пару секунд.

   Когда сайт работает через сервер (хостинг/превью), список
   читается прямо из папок — тогда видны вообще все фото.

   Сортировка: сначала более новые даты,
   внутри одной даты — меньший номер выше.

   Если фотография не загружается — карточка просто исчезает.
   Если по предмету фото нет — «ДЗ нет».
   ============================================================ */

(function () {
  'use strict';

  var SUBJECTS = [
    'Алгебра', 'Геометрия', 'ВиС', 'Русский язык', 'Английский язык',
    'Литература', 'Физика', 'Информатика', 'Биология', 'География', 'История'
  ];

  var MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];

  var EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
  /* ДДММГГГГ(№) или ДДММГГГГ + № */
  var NAME_RE = /^(\d{8})\((\d+)\)$|^(\d{8,})$/;

  var REFRESH_INTERVAL = 20000;   // проверка обновлений каждые 20 секунд
  var PROBE_EXTENSIONS = ['', '.png', '.jpg', '.jpeg', '.webp'];
  var NUM_MIN = 1;                // с какого номера искать
  var NUM_MAX = 15;               // до какого номера искать
  var NEAR_BACK = 45;             // ближайшие даты: от -45 до +45 дней
  var NEAR_FWD = 45;              // (ищутся первыми и перепроверяются чаще)
  var PROBE_BATCH = 250;          // сколько пар «дата+номер» проверять одновременно
  var PROBE_TIMEOUT = 20000;      // максимум на проверку одного имени

  /* ---------- Элементы ---------- */

  var select = document.getElementById('subject-select');
  var chooseBtn = document.getElementById('choose-btn');
  var gallery = document.getElementById('gallery');
  var galleryTitle = document.getElementById('subject-title');
  var photoCount = document.getElementById('photo-count');
  var emptyState = document.getElementById('empty-state');
  var emptyTitle = document.getElementById('empty-title');

  /* ---------- Состояние ---------- */

  var apiAvailable = false;    // сервер отдаёт список из папок
  var apiManifest = null;
  var apiKey = '';
  var caches = {};             // предмет -> { names:{имя:1}, deepNames:{}, deep:bool, everProbed:bool }
  var searching = {};          // предмет -> идёт самый первый поиск
  var currentSubject = null;
  var currentPhotos = [];      // [{ name, url, info }]
  var probeToken = 0;          // гасит устаревшие поиски
  var probeRunning = false;
  var lastProbeRun = 0;
  var renderTimer = null;

  /* ---------- Разбор имени файла ---------- */

  function looksLikePhoto(fileName) {
    if (EXT_RE.test(fileName)) return true;
    var dot = fileName.lastIndexOf('.');
    var base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
    return NAME_RE.test(base);
  }

  function parseFileName(fileName) {
    var dot = fileName.lastIndexOf('.');
    var base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
    var m = base.match(NAME_RE);
    if (!m) return null;

    var digits = m[1] !== undefined ? m[1] : m[3];
    var num = m[2] !== undefined ? parseInt(m[2], 10)
            : (digits.length > 8 ? parseInt(digits.slice(8), 10) : 0);

    var day = parseInt(digits.slice(0, 2), 10);
    var month = parseInt(digits.slice(2, 4), 10);
    var year = parseInt(digits.slice(4, 8), 10);

    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (year < 1990 || year > 2100) return null;

    return {
      day: day,
      month: month,
      year: year,
      num: num,
      time: new Date(year, month - 1, day).getTime()
    };
  }

  function formatDate(info) {
    if (!info) return 'Дата неизвестна';
    return info.day + ' ' + MONTHS[info.month - 1] + ' ' + info.year;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Сортировка: новее — выше; внутри даты меньший номер — выше */
  function sortPhotos(list) {
    list.sort(function (a, b) {
      if (a.info && b.info) {
        if (b.info.time !== a.info.time) return b.info.time - a.info.time;
        return a.info.num - b.info.num;
      }
      if (a.info) return -1;
      if (b.info) return 1;
      return a.name.localeCompare(b.name, 'ru');
    });
    return list;
  }

  /* ---------- Список фото для показа ---------- */

  function buildPhotoList(subject) {
    var names;
    if (apiAvailable) {
      names = ((apiManifest || {})[subject]) || [];
    } else {
      var cache = caches[subject];
      names = cache ? Object.keys(cache.names) : [];
    }
    return sortPhotos(names.filter(looksLikePhoto).map(function (name) {
      return {
        name: name,
        url: encodeURI(subject + '/' + name),
        info: parseFileName(name)
      };
    }));
  }

  /* ---------- Режим сервера (хостинг/превью): читаем папки напрямую ---------- */

  function fetchList() {
    return fetch('/api/photos', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        apiAvailable = true;
        var next = data && Object.keys(data).length ? data : null;
        var key = JSON.stringify(next);
        var changed = apiKey !== '' && key !== apiKey;
        apiKey = key;
        apiManifest = next;
        return changed;
      })
      .catch(function () {
        apiAvailable = false;
        apiManifest = null;
      });
  }

  /* ---------- Поиск фото по именам (сайт открыт как файл) ---------- */

  /* учебный год: 1 сентября — 30 июня */
  function schoolYearDays() {
    var now = new Date();
    var y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    var days = [];
    var d = new Date(y, 8, 1);
    var end = new Date(y + 1, 5, 30);
    while (d <= end) {
      days.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  function startOfToday() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function probeImage(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      var settled = false;
      var t = setTimeout(function () {
        if (!settled) { settled = true; resolve(false); }
      }, PROBE_TIMEOUT);
      img.onload = function () {
        if (!settled) { settled = true; clearTimeout(t); resolve(true); }
      };
      img.onerror = function () {
        if (!settled) { settled = true; clearTimeout(t); resolve(false); }
      };
      img.src = url;
    });
  }

  /* Проверяем пары «дата+номер» параллельно; для каждой пары пробуем
     варианты имени (скобки/цифра × расширения) до первого найденного.
     onFind вызывается для каждого найденного имени. */
  function probePairs(subject, days, onFind, alive) {
    var tasks = [];
    days.forEach(function (d) {
      var base = pad2(d.getDate()) + pad2(d.getMonth() + 1) + d.getFullYear();
      for (var n = NUM_MIN; n <= NUM_MAX; n++) {
        tasks.push({ base: base, n: n });
      }
    });

    var found = {};
    var half = PROBE_EXTENSIONS.length;
    var total = tasks.length;
    var i = 0, active = 0, doneCount = 0;

    function runTask(task, done) {
      var vi = 0;
      function next() {
        if (!alive() || vi >= half * 2) { done(); return; }
        var ext = PROBE_EXTENSIONS[vi % half];
        var withParens = vi < half;   // сначала вариант со скобками
        vi++;
        var name = withParens ? task.base + '(' + task.n + ')' + ext
                              : task.base + task.n + ext;
        probeImage(encodeURI(subject + '/' + name)).then(function (ok) {
          if (ok) { found[name] = 1; onFind(name); done(); }
          else next();
        });
      }
      next();
    }

    return new Promise(function (resolve) {
      if (!total) { resolve(found); return; }
      function pump() {
        while (active < PROBE_BATCH && i < total) {
          var task = tasks[i++];
          active++;
          runTask(task, function () {
            active--;
            doneCount++;
            if (doneCount >= total) resolve(found);
            else pump();
          });
        }
      }
      pump();
    });
  }

  /* Полный проход по одному предмету: сначала ближайшие даты (±45 дней),
     потом остальной учебный год — один раз, результат запоминается. */
  function probeSubjectNow(subject) {
    probeToken++;              // предыдущий поиск больше не актуален
    probeRunning = true;
    var token = probeToken;
    var alive = function () { return token === probeToken && currentSubject === subject; };

    var cache = caches[subject];
    if (!cache) cache = caches[subject] = { names: {}, deepNames: {}, deep: false, everProbed: false };

    if (!cache.everProbed) searching[subject] = true;
    lastProbeRun = Date.now();

    var today = startOfToday();
    var near = [], deep = [];
    schoolYearDays().forEach(function (d) {
      var diff = Math.round((d - today) / 86400000);
      if (diff >= -NEAR_BACK && diff <= NEAR_FWD) near.push(d);
      else deep.push(d);
    });
    near.sort(function (a, b) { return b - a; });   // новые даты — первыми
    deep.sort(function (a, b) { return b - a; });

    function onFind(name) {
      if (!alive()) return;
      cache.names[name] = 1;
      scheduleRender();
    }

    function finish(nearSet, deepSet) {
      if (!alive()) return;
      probeRunning = false;
      searching[subject] = false;
      cache.everProbed = true;
      var names = {};
      var n;
      for (n in nearSet) if (nearSet.hasOwnProperty(n)) names[n] = 1;
      for (n in deepSet) if (deepSet.hasOwnProperty(n)) names[n] = 1;
      cache.names = names;
      scheduleRender();
    }

    probePairs(subject, near, onFind, alive).then(function (nearSet) {
      if (!alive()) return;
      if (cache.deep || location.protocol !== 'file:') {
        finish(nearSet, cache.deepNames);
      } else {
        probePairs(subject, deep, onFind, alive).then(function (deepSet) {
          if (!alive()) return;
          cache.deepNames = deepSet;
          cache.deep = true;
          finish(nearSet, deepSet);
        });
      }
    });
  }

  /* ---------- Отображение предмета ---------- */

  function fillSelect() {
    var current = select.value;
    select.innerHTML = '';
    SUBJECTS.forEach(function (subject) {
      var opt = document.createElement('option');
      opt.value = subject;
      opt.textContent = subject;
      select.appendChild(opt);
    });
    if (current && SUBJECTS.indexOf(current) !== -1) select.value = current;
  }

  function renderEmpty(subject) {
    gallery.innerHTML = '';
    /* пока идёт самый первый поиск фото — не спешим писать, что их нет */
    if (!apiAvailable && searching[subject]) {
      emptyTitle.textContent = 'Ищу фото…';
    } else {
      emptyTitle.textContent = 'ДЗ нет';
    }
    emptyState.hidden = false;
  }

  function updateCountBadge() {
    if (!currentPhotos.length) {
      photoCount.hidden = true;
      return;
    }
    photoCount.hidden = false;
    photoCount.textContent = currentPhotos.length + ' фото';
  }

  function renderSubject(subject) {
    currentPhotos = buildPhotoList(subject);

    emptyState.hidden = true;
    updateCountBadge();

    if (!currentPhotos.length) {
      renderEmpty(subject);
      return;
    }

    gallery.innerHTML = '';
    currentPhotos.forEach(function (photo, i) {
      gallery.appendChild(createCard(photo, i));
    });
  }

  function loadSubject(subject) {
    if (!subject) return;
    currentSubject = subject;
    select.value = subject;

    galleryTitle.textContent = subject;
    document.title = subject + ' — Экспресс-ДЗ';

    renderSubject(subject);

    if (!apiAvailable) probeSubjectNow(subject);
  }

  /* перерисовка не чаще, чем раз в 200 мс (фото находятся пачками) */
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      if (currentSubject) renderSubject(currentSubject);
    }, 200);
  }

  /* ---------- Карточка фото: дата НАД фотографией ---------- */

  function createCard(photo, index) {
    var card = document.createElement('div');
    card.className = 'photo-card';
    card.style.animationDelay = Math.min(index * 45, 400) + 'ms';

    var dateRow = document.createElement('div');
    dateRow.className = 'card-date';

    var dateText = document.createElement('span');
    dateText.className = 'date-text';
    dateText.textContent = formatDate(photo.info);
    dateRow.appendChild(dateText);

    if (photo.info && photo.info.num > 0) {
      var dateNum = document.createElement('span');
      dateNum.className = 'date-num';
      dateNum.textContent = '№' + photo.info.num;
      dateRow.appendChild(dateNum);
    }

    var frame = document.createElement('div');
    frame.className = 'photo-frame';

    var img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = 'Домашнее задание, ' + formatDate(photo.info);
    img.src = photo.url;

    img.addEventListener('load', function () {
      img.classList.add('loaded');
      frame.classList.add('has-img');
    });

    /* если фото не загрузилось — карточка просто исчезает */
    img.addEventListener('error', function () {
      card.remove();
      var idx = currentPhotos.indexOf(photo);
      if (idx !== -1) currentPhotos.splice(idx, 1);
      updateCountBadge();
      if (!currentPhotos.length) renderEmpty(currentSubject);
    });

    frame.appendChild(img);
    card.appendChild(dateRow);
    card.appendChild(frame);

    return card;
  }

  /* ---------- Кнопка «Выбрать» и меню ---------- */

  chooseBtn.addEventListener('click', function () {
    loadSubject(select.value);
  });

  select.addEventListener('change', function () {
    loadSubject(select.value);
  });

  /* ---------- Автообновление ---------- */

  function tick() {
    if (apiAvailable) {
      fetchList().then(function (changed) {
        if (changed && currentSubject) renderSubject(currentSubject);
      });
    } else if (currentSubject && !probeRunning && Date.now() - lastProbeRun > 25000) {
      probeSubjectNow(currentSubject);
    }
  }

  setInterval(tick, REFRESH_INTERVAL);

  window.addEventListener('focus', function () {
    if (apiAvailable) {
      fetchList().then(function (changed) {
        if (changed && currentSubject) renderSubject(currentSubject);
      });
    } else if (currentSubject && !probeRunning && Date.now() - lastProbeRun > 12000) {
      probeSubjectNow(currentSubject);
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (apiAvailable) {
      fetchList().then(function (changed) {
        if (changed && currentSubject) renderSubject(currentSubject);
      });
    } else if (currentSubject && !probeRunning && Date.now() - lastProbeRun > 12000) {
      probeSubjectNow(currentSubject);
    }
  });

  /* ---------- Запуск ---------- */

  fillSelect();

  if (location.protocol === 'file:') {
    loadSubject(SUBJECTS[0]);
  } else {
    fetchList().then(function () {
      loadSubject(SUBJECTS[0]);
    });
  }
})();
