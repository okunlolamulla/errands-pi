import { supabase } from '../config/supabase.js';
import { notifyPaid } from './notify.js';

// Runs once when a payment has just been applied ('paid'): emails the receipt / alerts the admin.
// Used by the Paystack webhook AND by the thank-you page's status check, whichever hears about the payment first.
export async function afterPaid(reference) {
  const { data: payment } = await supabase.from('payments').select('errand_id').eq('reference', reference).maybeSingle();
  if (!payment) return;
  const { data: errand } = await supabase.from('errand_requests').select('*').eq('errand_id', payment.errand_id).maybeSingle();
  if (!errand) return;
  let moving;
  if (errand.service_type === 'Moving service') {
    const { data: booking } = await supabase.from('moving_bookings').select('*').eq('errand_id', errand.errand_id).maybeSingle();
    if (booking) moving = { booking, reference };
  }
  const result = await notifyPaid(errand, moving);
  if (moving && result.receiptSent) await supabase.from('moving_bookings').update({ receipt_sent_at: new Date().toISOString() }).eq('errand_id', errand.errand_id);
  console.log('[notify paid]', errand.errand_id, JSON.stringify(result));
}
