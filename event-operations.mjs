// Keep the event write contract in one place so create/edit error behavior is testable.
export async function saveEventRecord(client, editId, payload) {
  const request = editId
    ? client.from('events').update(payload).eq('id', editId).select('id')
    : client.from('events').insert([{ ...payload, published: false }]).select('id');
  const result = await request;
  if (result?.error) throw result.error;
  if (!Array.isArray(result?.data) || result.data.length !== 1 || !result.data[0]?.id) {
    const error = new Error('The server did not confirm a saved event row. Refresh the event list before retrying.');
    error.code = 'EVENT_WRITE_NOT_CONFIRMED';
    throw error;
  }
  return result.data[0];
}
