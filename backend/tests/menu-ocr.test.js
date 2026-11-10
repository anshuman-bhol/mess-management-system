const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMenuScheduleText } = require('../../frontend/menu-ocr');

test('menu OCR parses and orders table rows for review', () => {
  const rows = parseMenuScheduleText([
    'DAY | MEAL | TIME | MENU',
    'Tuesday | Lunch | 12:30 - 2:30 PM | Rice, dal and vegetables',
    'Monday | Breakfast | 7:30 - 9:00 AM | Poha and fruit'
  ].join('\n'));

  assert.deepEqual(rows, [
    { day: 'Monday', meal: 'Breakfast', time: '7:30 - 9:00 AM', dish: 'Poha and fruit' },
    { day: 'Tuesday', meal: 'Lunch', time: '12:30 - 2:30 PM', dish: 'Rice, dal and vegetables' }
  ]);
});

test('menu OCR carries the day across wrapped table rows and defaults missing times', () => {
  const rows = parseMenuScheduleText([
    'Wednesday Breakfast Upma and tea',
    'Dinner Rice, curry and salad'
  ].join('\n'));

  assert.deepEqual(rows, [
    { day: 'Wednesday', meal: 'Breakfast', time: '7:30 – 9:00 AM', dish: 'Upma and tea' },
    { day: 'Wednesday', meal: 'Dinner', time: '7:30 – 9:00 PM', dish: 'Rice, curry and salad' }
  ]);
});

test('menu OCR does not create rows when it cannot identify a meal table', () => {
  assert.deepEqual(parseMenuScheduleText('Welcome to the dining hall\nMenu for the week'), []);
});

test('menu OCR parses column-grid meals with pipe separators', () => {
  const rows = parseMenuScheduleText([
    'Monday | Poha and tea | Rice and dal | Paneer and roti',
    'Tuesday | Idli and sambar | Rajma chawal | Egg curry and roti'
  ].join('\n'));

  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { day: 'Monday', meal: 'Breakfast', time: '7:30 – 9:00 AM', dish: 'Poha and tea' });
  assert.deepEqual(rows[1], { day: 'Monday', meal: 'Lunch', time: '12:30 – 2:30 PM', dish: 'Rice and dal' });
  assert.deepEqual(rows[2], { day: 'Monday', meal: 'Dinner', time: '7:30 – 9:00 PM', dish: 'Paneer and roti' });
});

test('menu OCR parses table data with spatial TSV coordinates', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t50\t100\t50\t20\t90\tDay',
    '5\t1\t1\t1\t1\t2\t200\t100\t80\t20\t90\tBreakfast',
    '5\t1\t1\t1\t1\t3\t500\t100\t50\t20\t90\tLunch',
    '5\t1\t1\t1\t1\t4\t800\t100\t50\t20\t90\tDinner',
    '5\t1\t1\t1\t2\t1\t50\t200\t60\t20\t90\tMonday',
    '5\t1\t1\t1\t2\t2\t200\t200\t120\t20\t90\tPoha and chai',
    '5\t1\t1\t1\t2\t3\t500\t200\t100\t20\t90\tDal and rice',
    '5\t1\t1\t1\t2\t4\t800\t200\t100\t20\t90\tPaneer and roti',
    '5\t1\t1\t1\t3\t1\t50\t300\t60\t20\t90\tTuesday',
    '5\t1\t1\t1\t3\t2\t200\t300\t120\t20\t90\tIdli sambar',
    '5\t1\t1\t1\t3\t3\t500\t300\t100\t20\t90\tRajma chawal',
    '5\t1\t1\t1\t3\t4\t800\t300\t100\t20\t90\tEgg curry',
    '5\t1\t1\t1\t4\t1\t50\t400\t60\t20\t90\tWednesday',
    '5\t1\t1\t1\t4\t2\t200\t400\t120\t20\t90\tUpma',
    '5\t1\t1\t1\t4\t3\t500\t400\t100\t20\t90\tChole bhature',
    '5\t1\t1\t1\t4\t4\t800\t400\t100\t20\t90\tBiryani'
  ].join('\n');

  const rows = parseMenuScheduleText('', tsv);
  assert.equal(rows.length, 9);
  assert.equal(rows[0].day, 'Monday');
  assert.equal(rows[0].meal, 'Breakfast');
  assert.equal(rows[0].dish, 'Poha and chai');
});
