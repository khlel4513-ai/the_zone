const FIELD_LABELS = {
  title_ar: { ar: 'العنوان العربي', en: 'Arabic title' },
  title_en: { ar: 'العنوان الإنجليزي', en: 'English title' },
  event_date: { ar: 'تاريخ الفعالية', en: 'Event date' },
  event_time: { ar: 'وقت الفعالية', en: 'Event time' },
  price_iqd: { ar: 'السعر', en: 'Price' },
  category: { ar: 'التصنيف', en: 'Category' },
  total_seats: { ar: 'السعة الإجمالية', en: 'Total capacity' },
  show_ticket_to_attendee: { ar: 'إظهار التذكرة للمشارك', en: 'Attendee ticket visibility' },
};

const OPERATIONS = {
  create_event: { ar: 'فشل إنشاء الفعالية', en: 'Event creation failed' },
  update_event: { ar: 'فشل تحديث الفعالية', en: 'Event update failed' },
  publish_event: { ar: 'فشل نشر الفعالية', en: 'Event publishing failed' },
  unpublish_event: { ar: 'فشل إلغاء نشر الفعالية', en: 'Event unpublishing failed' },
  delete_event: { ar: 'فشل حذف الفعالية', en: 'Event deletion failed' },
  refresh_events: { ar: 'تعذر تحديث قائمة الفعاليات', en: 'Event list refresh failed' },
  load_events: { ar: 'تعذر تحميل الفعاليات', en: 'Event loading failed' },
  upload_event_image: { ar: 'فشل رفع صورة الفعالية', en: 'Event image upload failed' },
};

function errorText(error) {
  return String(error?.message || error?.error_description || error || '');
}

function safeTechnicalDetails(error) {
  const code = String(error?.code || error?.status || '').trim();
  const message = errorText(error)
    .replace(/bearer\s+\S+/gi, '[redacted]')
    .replace(/(service[_ -]?role|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:sb_(?:publishable|secret)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[credential redacted]')
    .replace(/(?:\n|\r)\s*at\s+[^\n\r]+/g, ' [stack redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/\b(?:\+?964|0)7\d{9}\b/g, '[phone redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 360);
  const constraint = String(error?.constraint || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
  const parts = [];
  if (code) parts.push(`code=${code}`);
  if (error?.column) parts.push(`field=${String(error.column).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100)}`);
  if (constraint) parts.push(`constraint=${constraint}`);
  if (message) parts.push(message);
  return parts.join(' · ') || 'No technical details were returned.';
}

function fieldFromError(error) {
  if (error?.column) return String(error.column);
  const text = `${errorText(error)} ${error?.details || ''}`;
  return text.match(/could not find the\s+["'`]([^"'`]+)["'`]\s+column/i)?.[1]
    || text.match(/(?:column|field)\s+["'`]([a-z_][a-z0-9_]*)["'`]/i)?.[1]
    || text.match(/(?:column|field)\s+([a-z_][a-z0-9_]*)(?:\s|$)/i)?.[1]
    || '';
}

export function describeAdminError(operation, error, language = 'ar') {
  const lang = String(language).toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const op = OPERATIONS[operation] || { ar: 'تنفيذ العملية', en: 'Operation' };
  const code = String(error?.code || error?.status || '');
  const text = `${errorText(error)} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  const field = fieldFromError(error);
  const fieldLabel = FIELD_LABELS[field]?.[lang] || field || (lang === 'ar' ? 'حقل غير محدد' : 'an unspecified field');
  let reason;
  let next;

  if (code === 'EVENT_WRITE_NOT_CONFIRMED') {
    reason = lang === 'ar' ? 'لم يصل تأكيد بوجود سجل محفوظ؛ تعذر تحديد نتيجة الكتابة.' : 'The server did not confirm a saved row, so the write result is uncertain.';
    next = lang === 'ar' ? 'حدّث قائمة الفعاليات للتحقق قبل إعادة المحاولة لتجنب إنشاء نسخة مكررة.' : 'Refresh the event list to verify the result before retrying to avoid a duplicate.';
  } else if (code === '23502' || /not-null constraint|cannot be null/.test(text)) {
    reason = lang === 'ar' ? `قيمة مطلوبة مفقودة: ${fieldLabel}.` : `A required value is missing: ${fieldLabel}.`;
    next = lang === 'ar' ? 'أكمل الحقل المحدد ثم أعد الحفظ.' : 'Complete the indicated field and save again.';
  } else if (code === '23505' || /duplicate key|unique constraint/.test(text)) {
    reason = lang === 'ar' ? 'توجد فعالية أخرى تستخدم القيمة نفسها.' : 'Another event already uses this value.';
    next = lang === 'ar' ? 'راجع العنوان أو المعرّف ثم أعد المحاولة.' : 'Review the title or identifier, then try again.';
  } else if (code === '42501' || code === '401' || code === '403' || /permission denied|row-level security|violates row.level security|not authorized/.test(text)) {
    reason = lang === 'ar' ? 'رفضت صلاحيات قاعدة البيانات العملية.' : 'Database permissions rejected this operation.';
    next = lang === 'ar' ? 'تحقق من صلاحية حساب الإدارة وسياسات الوصول.' : 'Verify the signed-in admin role and database access policies.';
  } else if (code === '42703' || code === 'PGRST204' || /schema cache|could not find the .*column|column .* does not exist/.test(text)) {
    const missing = field ? ` (${field})` : '';
    reason = lang === 'ar' ? `قاعدة البيانات لا تحتوي على عمود مطلوب${missing}.` : `The database is missing a required column${missing}.`;
    next = field === 'show_ticket_to_attendee'
      ? (lang === 'ar' ? 'تحقق من تطبيق ترحيل 202611190004 قبل إدارة إعداد إظهار التذاكر.' : 'Verify migration 202611190004 is applied before managing attendee ticket visibility.')
      : (lang === 'ar' ? 'طابق إصدار لوحة الإدارة مع مخطط قاعدة البيانات.' : 'Align the dashboard version with the database schema.');
  } else if (code === '42P01' || code === 'PGRST205' || /relation .* does not exist|table .* does not exist/.test(text)) {
    reason = lang === 'ar' ? 'جدول الفعاليات غير متاح في قاعدة البيانات.' : 'The events table is unavailable in the database.';
    next = lang === 'ar' ? 'تحقق من مخطط المشروع وإصدار قاعدة البيانات.' : 'Verify the project schema and database version.';
  } else if (code === '23503' || /foreign key constraint/.test(text)) {
    reason = lang === 'ar' ? 'ترتبط الفعالية بسجل غير موجود أو غير صالح.' : 'The event references a missing or invalid related record.';
    next = lang === 'ar' ? 'حدّث البيانات المرتبطة ثم أعد المحاولة.' : 'Refresh the related data and try again.';
  } else if (code === '23514' || /check constraint/.test(text)) {
    reason = lang === 'ar' ? `رفضت قاعدة البيانات قيمة ${fieldLabel} بسبب شرط تحقق.` : `The database rejected ${fieldLabel} because it failed a validation rule.`;
    next = lang === 'ar' ? 'راجع القيمة والحدود المقبولة ثم أعد المحاولة.' : 'Review the accepted value and limits, then try again.';
  } else if (code === '22P02' || code === '22007' || /invalid input syntax|date\/time field value/.test(text)) {
    reason = lang === 'ar' ? `تنسيق ${fieldLabel} غير صالح.` : `${fieldLabel} has an invalid format.`;
    next = lang === 'ar' ? 'راجع التاريخ والوقت والأرقام ثم أعد المحاولة.' : 'Review the date, time, and numeric values, then try again.';
  } else if (/failed to fetch|network|fetch.*failed|load failed|networkerror/.test(text) || error?.name === 'TypeError') {
    const operationName = operation === 'create_event' ? (lang === 'ar' ? 'حفظ الفعالية' : 'the event save') : op[lang].replace(/ failed$/, '');
    reason = lang === 'ar' ? `انقطع الاتصال قبل تأكيد ${operationName}.` : `The connection failed before ${operationName.toLowerCase()} could be confirmed.`;
    next = lang === 'ar' ? 'تحقق من الاتصال وحدّث قائمة الفعاليات قبل إعادة المحاولة لتجنب التكرار.' : 'Check connectivity and refresh the event list before retrying to avoid duplicates.';
  } else {
    reason = lang === 'ar' ? 'رفض الخادم حفظ التغييرات.' : 'The server rejected the changes.';
    next = lang === 'ar' ? 'احتفظ ببيانات النموذج وراجع التفاصيل التقنية أو تواصل مع مسؤول النظام.' : 'Keep the form open, review the technical details, or contact the system administrator.';
  }

  return {
    title: op[lang],
    reason,
    next,
    technical: safeTechnicalDetails(error),
  };
}
