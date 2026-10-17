// src/i18n.assist.ts
//
// The assist features (2026-10-15): the overlay's live helpers, the launcher's
// Coming up today / You owe / Catch up (src/components/assist/AssistToday.tsx)
// and the catch-up row in Settings › Calendar. English source → [ru, zh, ja,
// es], one row per sentence, the same shape as src/i18n.trial.ts.
//
// The rows must match the strings those components pass to t() exactly:
// src/lib/__tests__/AssistI18n2026_10_15.test.mjs fails on a missing row.

type Row = readonly [ru: string, zh: string, ja: string, es: string];

const ROWS: Record<string, Row> = {
  // ── Overlay: live helpers ──
  'What did I miss?': ['Что я пропустил?', '我错过了什么？', '何を聞き逃した？', '¿Qué me perdí?'],
  'Define': ['Объяснить', '解释', '意味', 'Definir'],
  'Sound smart': ['Умная мысль', '说点有见地的', '鋭い一言', 'Aporta algo'],

  // ── Launcher: Coming up today ──
  'Coming up today': ['Сегодня впереди', '今天接下来', '今日このあと', 'Hoy, a continuación'],
  'Brief me': ['Подготовь меня', '会前简报', '事前に確認', 'Prepárame'],
  'Draft a note to the attendees': ['Написать участникам', '给参会者写一条消息', '参加者へのメモを作成', 'Escribir a los asistentes'],
  'Running late': ['Опаздываю', '我会晚到', '遅れます', 'Llego tarde'],
  'Are you joining?': ['Вы присоединитесь?', '你还会参加吗？', '参加されますか？', '¿Te unes?'],
  'Can we move it?': ['Можно перенести?', '能改个时间吗？', '日程を変更できますか？', '¿Podemos moverla?'],
  'Putting your brief together…': ['Готовлю сводку…', '正在整理简报…', '準備中…', 'Preparando tu resumen…'],
  'The brief could not be put together for this event.': ['Не удалось подготовить сводку для этого события.', '无法为此日程生成简报。', 'この予定の事前情報をまとめられませんでした。', 'No se pudo preparar el resumen de este evento.'],
  'Who is coming': ['Кто будет', '参会人员', '参加者', 'Quién viene'],
  'last met': ['последняя встреча', '上次见面', '前回', 'última reunión'],
  'no earlier meeting saved': ['раньше встреч не было', '没有保存过的会议', '過去の会議の記録なし', 'sin reuniones anteriores guardadas'],
  'Still owes:': ['Ещё должен:', '仍待完成：', '未完了：', 'Pendiente:'],
  'You still owe them': ['Вы ещё должны', '你仍欠他们的', 'あなたの未完了の項目', 'Lo que aún les debes'],
  'Worth raising': ['Стоит обсудить', '值得提出', '話題にしたいこと', 'Para comentar'],
  'Write again': ['Написать заново', '重新生成', '書き直す', 'Volver a escribir'],
  'From your notes only: meeting notes are kept from cloud models in Settings › AI Providers.': [
    'Только из ваших заметок: заметки о встречах не передаются облачным моделям (Настройки › AI-провайдеры).',
    '仅根据你的笔记：会议笔记已在 设置 › AI 提供商 中设为不发送给云端模型。',
    'メモのみから作成：会議メモは 設定 › AI プロバイダー でクラウドモデルに送らない設定です。',
    'Solo a partir de tus notas: las notas de reuniones no se envían a modelos en la nube (Ajustes › Proveedores de IA).',
  ],
  'Nothing saved yet about this meeting or the people on it.': [
    'Пока ничего не сохранено об этой встрече или её участниках.',
    '还没有保存关于这次会议或参会者的内容。',
    'この会議や参加者についての記録はまだありません。',
    'Aún no hay nada guardado sobre esta reunión ni sus asistentes.',
  ],
  'To': ['Кому', '收件人', '宛先', 'Para'],
  'min': ['мин', '分钟', '分', 'min'],
  'Open in mail app': ['Открыть в почте', '在邮件应用中打开', 'メールアプリで開く', 'Abrir en la app de correo'],
  'Open in Gmail': ['Открыть в Gmail', '在 Gmail 中打开', 'Gmail で開く', 'Abrir en Gmail'],
  'Copied. Paste it into your email or chat.': ['Скопировано. Вставьте в письмо или чат.', '已复制。粘贴到邮件或聊天中即可。', 'コピーしました。メールやチャットに貼り付けてください。', 'Copiado. Pégalo en tu correo o chat.'],
  'Could not copy. Select the text and copy it instead.': ['Не удалось скопировать. Выделите текст и скопируйте вручную.', '无法复制。请选中文本后手动复制。', 'コピーできませんでした。テキストを選択してコピーしてください。', 'No se pudo copiar. Selecciona el texto y cópialo.'],
  'No mail app opened. The draft is on your clipboard instead.': ['Почтовое приложение не открылось. Черновик скопирован.', '没有打开邮件应用。草稿已复制到剪贴板。', 'メールアプリが開きませんでした。下書きはクリップボードにあります。', 'No se abrió ninguna app de correo. El borrador está en tu portapapeles.'],

  // ── Launcher: You owe ──
  'You owe': ['Вы должны', '你待办的', 'あなたの宿題', 'Tus pendientes'],
  'Mark as done': ['Отметить как сделанное', '标记为已完成', '完了にする', 'Marcar como hecho'],
  'Mark as not done': ['Снять отметку', '标记为未完成', '未完了に戻す', 'Marcar como no hecho'],
  'Overdue': ['Просрочено', '已逾期', '期限切れ', 'Vencido'],
  'Show all': ['Показать все', '显示全部', 'すべて表示', 'Ver todo'],

  // ── Launcher: Catch up ──
  'Catch up': ['Сводка', '快速回顾', 'まとめ', 'Ponte al día'],
  'After your back-to-back meetings:': ['После встреч подряд:', '连续会议之后：', '連続した会議のあと：', 'Tras tus reuniones seguidas:'],
  'Decided': ['Решено', '已决定', '決定事項', 'Decidido'],
  'Yours to do': ['Ваши задачи', '你的待办', 'あなたのタスク', 'Te toca a ti'],

  // ── Settings › Calendar ──
  'Catch up after back-to-back meetings': ['Сводка после встреч подряд', '连续会议后的快速回顾', '連続した会議のあとにまとめる', 'Ponerte al día tras reuniones seguidas'],
  'After two or more meetings with less than 15 minutes between them, the launcher shows what was decided and what you took on, in one place.': [
    'После двух и более встреч с перерывом меньше 15 минут лаунчер показывает в одном месте, что решили и что вы взяли на себя.',
    '连续两场或更多会议且间隔不到 15 分钟时，启动器会在一处列出已做的决定和你接下的任务。',
    '間隔が 15 分未満の会議が 2 つ以上続いたあと、決まったことと引き受けたことをランチャーにまとめて表示します。',
    'Tras dos o más reuniones con menos de 15 minutos entre ellas, el lanzador muestra en un solo lugar lo que se decidió y lo que asumiste.',
  ],
};

function column(i: 0 | 1 | 2 | 3): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [en, row] of Object.entries(ROWS)) out[en] = row[i];
  return out;
}

export const ASSIST_EN = Object.freeze(Object.keys(ROWS));
export const ASSIST_RU = column(0);
export const ASSIST_ZH = column(1);
export const ASSIST_JA = column(2);
export const ASSIST_ES = column(3);
