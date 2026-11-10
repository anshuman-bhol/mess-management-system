(function (root) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const mealNames = ['Breakfast', 'Lunch', 'Dinner'];
  const defaultTimes = {
    Breakfast: '7:30 – 9:00 AM',
    Lunch: '12:30 – 2:30 PM',
    Dinner: '7:30 – 9:00 PM'
  };

  function cleanDish(str) {
    if (!str) return '';
    return str
      .replace(/^[;X\.\+\s\-\:\/,\>\<\~\|\=\*\(\)»_#@!&%]+/, '')
      .replace(/[;X\.\+\s\-\:\/,\>\<\~\|\=\*\(\)»_#@!&%]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sortMeals(list) {
    return list.sort((left, right) => {
      const dayOrder = days.indexOf(left.day) - days.indexOf(right.day);
      return dayOrder || mealNames.indexOf(left.meal) - mealNames.indexOf(right.meal);
    });
  }

  function parseTsv(tsv) {
    if (!tsv || typeof tsv !== 'string') return null;
    const lines = tsv.split(/\r?\n/);
    const words = [];
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 12 && parts[0] === '5') {
        const left = Number(parts[6]);
        const top = Number(parts[7]);
        const width = Number(parts[8]);
        const height = Number(parts[9]);
        const text = parts[11].trim();
        if (text && width > 0 && height > 0) {
          words.push({ left, top, width, height, text });
        }
      }
    }
    if (words.length < 10) return null;

    const bWord = words.find(w => /breakfast/i.test(w.text));
    const lWord = words.find(w => /lunch/i.test(w.text));
    const dWord = words.find(w => /dinner/i.test(w.text));
    if (!bWord || !lWord || !dWord) return null;

    const headerY = Math.min(bWord.top, lWord.top, dWord.top);

    const colBreakfast = { meal: 'Breakfast', min: Math.min(bWord.left - 40, 450), max: (bWord.left + lWord.left) / 2 };
    const colLunch = { meal: 'Lunch', min: (bWord.left + lWord.left) / 2, max: (lWord.left + dWord.left) / 2 };
    const colDinner = { meal: 'Dinner', min: (lWord.left + dWord.left) / 2, max: Infinity };

    const dayPatterns = [
      { day: 'Monday', regex: /mon(day)?/i },
      { day: 'Tuesday', regex: /tue(s|sday)?/i },
      { day: 'Wednesday', regex: /wed(nesday|ntids)?/i },
      { day: 'Thursday', regex: /thu(r|rs|rsday)?/i },
      { day: 'Friday', regex: /(fri(day)?|¥riday)/i },
      { day: 'Saturday', regex: /(sat(urday)?|saad)/i },
      { day: 'Sunday', regex: /(sun(day)?|simday)/i }
    ];

    const contentWords = words.filter(w => w.top > headerY + 40);
    const leftWords = contentWords.filter(w => w.left < colBreakfast.min + 60);

    const detectedRows = [];
    for (const { day, regex } of dayPatterns) {
      const match = leftWords.find(w => regex.test(w.text));
      if (match) detectedRows.push({ day, top: match.top });
    }

    let rowRanges = [];
    if (detectedRows.length >= 3) {
      detectedRows.sort((a, b) => a.top - b.top);
      const avgHeight = (detectedRows[detectedRows.length - 1].top - detectedRows[0].top) / (detectedRows.length - 1);
      const startY = detectedRows[0].top - 20;
      rowRanges = days.map((day, idx) => {
        const found = detectedRows.find(r => r.day === day);
        const top = found ? found.top - 20 : startY + idx * avgHeight;
        return { day, min: top, max: top + avgHeight };
      });
    } else {
      const minY = Math.min(...contentWords.map(w => w.top));
      const maxY = Math.max(...contentWords.map(w => w.top + w.height));
      const bandHeight = (maxY - minY) / 7;
      rowRanges = days.map((day, idx) => ({
        day,
        min: minY + idx * bandHeight,
        max: minY + (idx + 1) * bandHeight
      }));
    }

    const detected = new Map();
    for (const r of rowRanges) {
      for (const c of [colBreakfast, colLunch, colDinner]) {
        const cellWords = contentWords.filter(w => w.top >= r.min - 10 && w.top < r.max && w.left >= c.min && w.left < c.max);
        const dish = cleanDish(cellWords.map(w => w.text).join(' '));
        if (dish.length >= 2) {
          detected.set(`${r.day}:${c.meal}`, {
            day: r.day,
            meal: c.meal,
            time: defaultTimes[c.meal],
            dish: dish.slice(0, 500)
          });
        }
      }
    }
    return detected.size ? sortMeals([...detected.values()]) : null;
  }

  function parseMenuScheduleText(text, tsv) {
    if (!text && !tsv) return [];

    if (tsv) {
      const tsvResult = parseTsv(tsv);
      if (tsvResult && tsvResult.length) return tsvResult;
    }

    if (typeof text === 'object' && text !== null) {
      if (text.tsv) {
        const tsvResult = parseTsv(text.tsv);
        if (tsvResult && tsvResult.length) return tsvResult;
      }
      text = text.text || '';
    }

    if (typeof text !== 'string') return [];

    const detected = new Map();
    let currentDay = '';

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/[|•·]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!line) continue;

      const dayMatch = line.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
      if (dayMatch) currentDay = days.find(day => day.toLowerCase() === dayMatch[1].toLowerCase());
      if (!currentDay) continue;

      const foundMeals = mealNames.filter(meal => new RegExp(`\\b${meal}\\b`, 'i').test(line));
      if (foundMeals.length !== 1) continue;
      const meal = foundMeals[0];
      const timeMatch = line.match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i);
      const time = timeMatch ? timeMatch[0].replace(/\./g, '').replace(/\s+/g, ' ').trim() : defaultTimes[meal];
      const dish = line
        .replace(new RegExp(`\\b${currentDay}\\b`, 'ig'), ' ')
        .replace(new RegExp(`\\b${meal}\\b`, 'ig'), ' ')
        .replace(timeMatch?.[0] || '', ' ')
        .replace(/\b(day|date|meal|service|time|menu|dish)\b/ig, ' ')
        .replace(/^[\s:;,.\-–—/]+|[\s:;,.\-–—/]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (dish.length < 3 || dish.length > 500) continue;

      const key = `${currentDay}:${meal}`;
      const previous = detected.get(key);
      detected.set(key, previous
        ? { ...previous, dish: `${previous.dish} · ${dish}`.slice(0, 500) }
        : { day: currentDay, meal, time, dish });
    }

    if (detected.size) {
      return sortMeals([...detected.values()]);
    }

    // Fallback: Check for table rows formatted as Day | Dish1 | Dish2 | Dish3
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const dayMatch = line.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
      if (!dayMatch) continue;

      const dayName = days.find(d => d.toLowerCase() === dayMatch[1].toLowerCase());
      if (!dayName) continue;

      const remaining = cleanDish(line.replace(dayMatch[0], '').trim());
      if (remaining.length < 5) continue;

      const segments = remaining.split(/\s*\|\s*/);
      if (segments.length === 3) {
        mealNames.forEach((meal, idx) => {
          const d = cleanDish(segments[idx]);
          if (d.length >= 2) {
            detected.set(`${dayName}:${meal}`, { day: dayName, meal, time: defaultTimes[meal], dish: d.slice(0, 500) });
          }
        });
      }
    }

    return sortMeals([...detected.values()]);
  }

  const api = { parseMenuScheduleText, parseMenuSchedule: parseMenuScheduleText };
  root.MenuScheduleOcr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
