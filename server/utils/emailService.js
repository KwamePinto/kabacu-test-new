const nodemailer = require("nodemailer");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

const sesClient = new SESv2Client({
  region: process.env.AWS_REGION || "eu-north-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Nodemailer v9 SES format: { sesClient, SendEmailCommand } — not the old { ses, aws } shape
const transporter = nodemailer.createTransport({
  SES: { sesClient, SendEmailCommand },
});

module.exports = async function sendEmail({ to, subject, html, text, attachments }) {
  try {
    const info = await transporter.sendMail({
      from:    '"Kabacu" <verified@kabacu.com>',
      to,
      subject,
      text,
      html,
      // SESv2's SendEmailCommand always sends through Content.Raw when
      // nodemailer builds the message, so an attachment here needs no special
      // handling on the AWS side — it is standard MIME either way.
      attachments,
    });

    console.log("Email sent:", info.messageId);
    return info;

  } catch (error) {
    console.error("SES EMAIL ERROR:", error);
    throw error;
  }
};