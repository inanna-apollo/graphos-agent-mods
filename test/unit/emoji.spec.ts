import test from 'node:test'
import assert from 'node:assert/strict'
import { EMOJI, emojify } from '../../src/emoji.ts'

test('an incident.io bot line is drawn with its emoji', () => {
  assert.equal(
    emojify(':clipboard: Title :fire: *Severity*: S1 :pager: *Status*: Documenting'),
    '\u{1F4CB} Title \u{1F525} *Severity*: S1 \u{1F4DF} *Status*: Documenting',
  )
})

test('shortcodes run together, or sit against punctuation and custom emoji, still draw', () => {
  assert.equal(emojify(':fire::rocket:'), '\u{1F525}\u{1F680}')
  assert.equal(emojify('(:eyes:) *:warning:* Status:white_check_mark:'), '(\u{1F440}) *\u{26A0}\u{FE0F}* Status\u{2705}')
  assert.equal(emojify(':slack::fire:'), ':slack:\u{1F525}')
  assert.equal(emojify('no shortcodes here'), 'no shortcodes here')
})

test('custom, unknown, miscased and inherited names stay as written', () => {
  for (const text of [
    ':custom_team_emoji:',
    ':slack:',
    ':Fire:',
    ':not-a-real-emoji:',
    ':constructor: :__proto__: :toString: :hasOwnProperty:',
    ':',
    '::',
    ':::',
    ': fire :',
    '',
  ]) {
    assert.equal(emojify(text), text)
  }
  assert.equal(emojify('deploy :slack: done :rocket:'), 'deploy :slack: done \u{1F680}')
})

test('time-like and path-like text stays', () => {
  for (const text of ['10:30:45', 'at [12:00:00] then 9:15:30', 'a:b:c', 'a:x:c', 'std::fire::x', 'Foo::lock::new', 'host:8080:100:x']) {
    assert.equal(emojify(text), text)
  }
})

test('a skin tone becomes the matching modifier on the base emoji', () => {
  assert.equal(emojify(':+1::skin-tone-3:'), '\u{1F44D}\u{1F3FC}')
  assert.equal(emojify('well done :clap::skin-tone-6: all'), 'well done \u{1F44F}\u{1F3FF} all')
  // The tone follows the person, ahead of the joiner; a text-presentation selector gives way to it.
  assert.equal(emojify(':female-firefighter::skin-tone-4:'), '\u{1F469}\u{1F3FD}\u{200D}\u{1F692}')
  assert.equal(emojify(':v::skin-tone-2:'), '\u{270C}\u{1F3FB}')
  // A base that takes no tone is left alone and the tone is drawn as its own swatch.
  assert.equal(emojify(':fire::skin-tone-3:'), '\u{1F525}\u{1F3FC}')
})

test('every EMOJI value is one emoji and has no ASCII letters in it', () => {
  const oneEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v')
  for (const [name, emoji] of Object.entries(EMOJI)) {
    assert.ok(emoji.length > 0, `${name} is empty`)
    assert.doesNotMatch(emoji, /[A-Za-z]/, `${name} has a letter`)
    assert.match(emoji, oneEmoji, `${name} is not a single emoji in its emoji form`)
  }
})

test('the names ops tooling uses are all there', () => {
  const names = [
    '+1', 'thumbsup', '-1', 'raised_hands', 'clap', 'pray', 'wave', 'simple_smile', 'slightly_smiling_face',
    'fire', 'rotating_light', 'warning', 'pager', 'clipboard', 'control_knobs', 'bust_in_silhouette', 'busts_in_silhouette',
    'female-firefighter', 'male-firefighter', 'firefighter', 'white_check_mark', 'heavy_check_mark', 'x', 'no_entry',
    'red_circle', 'large_green_circle', 'large_yellow_circle', 'large_blue_circle', 'eyes', 'rocket', 'tada', 'bug',
    'hammer_and_wrench', 'memo', 'link', 'mag', 'bell', 'calendar', 'hourglass', 'stopwatch', 'chart_with_upwards_trend',
    'chart_with_downwards_trend', 'bar_chart', 'lock', 'key', 'shield', 'construction', 'bulb', 'speech_balloon',
    'thought_balloon', 'loudspeaker', 'mega', 'inbox_tray', 'outbox_tray', 'package', 'gear', 'zap', 'boom', 'sparkles',
    'star', '100', 'heavy_plus_sign', 'heavy_minus_sign', 'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right',
    'point_right', 'information_source', 'question', 'exclamation', 'double_exclamation_mark',
    ...Array.from({ length: 12 }, (_, hour) => `clock${hour + 1}`),
  ]
  for (const name of names) assert.ok(Object.hasOwn(EMOJI, name), `:${name}: is missing`)
  assert.equal(EMOJI['+1'], EMOJI.thumbsup)
})

test('long input with repeated delimiters completes quickly and never throws', () => {
  const started = Date.now()
  for (const piece of [':', '::', ':a', ':a:', ':aaaaaaaaaaaaaaaa', '::fire', 'a:x:', ':+1:x', '\u0000:fire']) {
    const text = piece.repeat(Math.ceil(400_000 / piece.length))
    assert.equal(typeof emojify(text), 'string')
  }
  assert.equal(emojify(':fire:'.repeat(100_000)), '\u{1F525}'.repeat(100_000))
  assert.equal(emojify(':a'.repeat(200_000)), ':a'.repeat(200_000))
  assert.doesNotThrow(() => emojify(undefined as unknown as string))
  assert.ok(Date.now() - started < 5_000)
})
