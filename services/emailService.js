function createEmailService({ Resend } = {}) {
  let client;

  function getClient() {
    if (!process.env.RESEND_API_KEY) {
      const error = new Error('Resend is not configured');
      error.name = 'EmailConfigurationError';
      throw error;
    }
    if (!process.env.EMAIL_FROM) {
      const error = new Error('Email sender is not configured');
      error.name = 'EmailConfigurationError';
      throw error;
    }
    if (!client) {
      const ResendClient = Resend || require('resend').Resend;
      client = new ResendClient(process.env.RESEND_API_KEY);
    }
    return client;
  }

  async function sendPasswordResetEmail(to, code) {
    const resend = getClient();
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to,
      subject: 'Your Dvepo password reset code',
      text: `Use this code to reset your Dvepo password: ${code}\n\nThis code expires in 15 minutes. If you did not request a password reset, you can ignore this email. Never share this code with anyone.`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;max-width:560px;margin:auto;padding:24px"><h1 style="font-size:22px">Reset your Dvepo password</h1><p>Enter this code in the password reset form:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 15 minutes.</p><p>If you did not request a password reset, you can ignore this email. Never share this code with anyone.</p></div>`,
    });

    if (error) {
      const deliveryError = new Error('Resend rejected the password recovery email');
      deliveryError.name = 'EmailDeliveryError';
      throw deliveryError;
    }
  }

  async function sendOrderNotificationEmail(to, subject, text) {
    const resend = getClient();
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to,
      subject: `Dvepo: ${String(subject).slice(0, 120)}`,
      text: String(text).slice(0, 5000),
    });
    if (error) {
      const deliveryError = new Error('Resend rejected the order notification email');
      deliveryError.name = 'EmailDeliveryError';
      throw deliveryError;
    }
  }

  return { sendPasswordResetEmail, sendOrderNotificationEmail };
}

module.exports = createEmailService();
module.exports.createEmailService = createEmailService;
