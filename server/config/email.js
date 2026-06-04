const nodemailer = require('nodemailer');
require('dotenv').config();

let transporter = null;
let isTestMode = true;

/**
 * Inicializa el transporte SMTP de Nodemailer. Si se han definido credenciales
 * en el entorno (SMTP_HOST/SMTP_USER/SMTP_PASS) se configura un transporte real;
 * en caso contrario se genera una cuenta de prueba de Ethereal, que captura los
 * correos y proporciona una URL de previsualización en lugar de entregarlos.
 */
async function init() {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        isTestMode = false;
        console.log('Email REAL configurado via ' + process.env.SMTP_HOST);
    } else {
        const account = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
            host: account.smtp.host,
            port: account.smtp.port,
            secure: account.smtp.secure,
            auth: { user: account.user, pass: account.pass }
        });
        console.log('Email en modo TEST (Ethereal). Configura SMTP_HOST en .env para correos reales.');
    }
}

/**
 * Envía un correo a través del transporte configurado. En modo de prueba
 * registra en consola la URL de previsualización de Ethereal. Los errores de
 * envío se capturan y registran sin propagarse, de modo que un fallo en la
 * notificación no interrumpa la operación principal que la origina.
 */
async function sendMail(options) {
    if (!transporter) return { previewUrl: null };
    try {
        const info = await transporter.sendMail({ from: '"Kilómetro 0" <noreply@km0.es>', ...options });
        const previewUrl = isTestMode ? nodemailer.getTestMessageUrl(info) : null;
        if (isTestMode && previewUrl) console.log('Email test (Ethereal): ' + previewUrl);
        else if (!isTestMode) console.log('Email enviado a ' + options.to);
        return { previewUrl };
    } catch (e) {
        console.error('Error enviando email:', e.message);
        return { previewUrl: null };
    }
}

// Envía al cliente el correo de confirmación de la reserva, incluyendo el
// código QR (adjunto como imagen embebida) que deberá presentar en la recogida.
async function sendOrderConfirmation({ to, orderId, qrCode, qrBuffer, items, total }) {
    const itemsHtml = items.map(i =>
        `<li><b>${i.name}</b> — ${parseFloat(i.price).toFixed(2)}€ (${i.producer_name || ''})</li>`
    ).join('');

    return sendMail({
        to,
        subject: 'Confirmación de Reserva #' + orderId,
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;padding:20px;border-radius:10px;">
            <div style="text-align:center;color:#2ecc71;"><h1>🌿 Kilómetro 0</h1></div>
            <h2>¡Gracias por tu compra local!</h2>
            <p>Muestra el código QR al productor cuando vayas a recoger:</p>
            <div style="text-align:center;margin:20px 0;">
                <img src="cid:qrcodeimg" alt="QR" style="width:200px;height:200px;">
            </div>
            <div style="background:#f9f9f9;padding:15px;text-align:center;border-radius:8px;font-size:1.5rem;font-weight:bold;letter-spacing:2px;">${qrCode}</div>
            <h3>Detalles:</h3>
            <ul>${itemsHtml}</ul>
            <h3>Total: ${parseFloat(total).toFixed(2)}€</h3>
            <p>Apoyando a productores locales haces el mundo más sostenible. ¡Gracias!</p>
        </div>`,
        attachments: qrBuffer ? [{ filename: 'qrcode.png', content: qrBuffer, cid: 'qrcodeimg' }] : []
    });
}

// Notifica al productor la recepción de un nuevo pedido que incluye sus
// productos, con el detalle de los artículos reservados y el importe.
async function sendNewOrderToProducer({ to, producerName, orderId, qrCode, clientEmail, items, total }) {
    const itemsHtml = items.map(i =>
        `<li><b>${i.name}</b> — ${parseFloat(i.price).toFixed(2)}€</li>`
    ).join('');

    return sendMail({
        to,
        subject: `Nuevo pedido recibido — ${qrCode}`,
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;padding:20px;border-radius:10px;">
            <div style="text-align:center;color:#2ecc71;"><h1>🌿 Kilómetro 0</h1></div>
            <h2>Hola ${producerName}, ¡tienes un nuevo pedido!</h2>
            <p>El cliente <b>${clientEmail}</b> acaba de reservar tus productos.</p>
            <div style="background:#f0fff0;border:2px dashed #2ecc71;padding:15px;border-radius:8px;text-align:center;margin:20px 0;">
                <div style="font-size:1.3rem;font-weight:bold;color:#1a7a3a;">${qrCode}</div>
                <p style="color:gray;font-size:0.9rem;margin:5px 0 0;">Código QR de referencia</p>
            </div>
            <h3>Artículos reservados:</h3>
            <ul>${itemsHtml}</ul>
            <h3>Total: ${parseFloat(total).toFixed(2)}€</h3>
            <p>Entra en tu <a href="${process.env.APP_URL || 'http://localhost:3000'}/producer-app#tab-orders">panel de productor</a> para ver el detalle completo.</p>
        </div>`
    });
}

// Remite al usuario el enlace de restablecimiento de contraseña, con vigencia
// limitada (una hora), generado durante el flujo de recuperación de acceso.
async function sendPasswordReset({ to, name, resetLink }) {
    return sendMail({
        to,
        subject: 'Recuperación de contraseña — Kilómetro 0',
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;padding:20px;border-radius:10px;">
            <div style="text-align:center;color:#2ecc71;"><h1>🌿 Kilómetro 0</h1></div>
            <h2>Hola ${name},</h2>
            <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón de abajo:</p>
            <div style="text-align:center;margin:30px 0;">
                <a href="${resetLink}" style="background:#1a7a3a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1rem;">Restablecer Contraseña</a>
            </div>
            <p style="color:gray;font-size:0.85rem;">Este enlace expira en 1 hora. Si no solicitaste el cambio, ignora este mensaje.</p>
            <p style="color:gray;font-size:0.8rem;word-break:break-all;">Enlace: ${resetLink}</p>
        </div>`
    });
}

module.exports = { init, sendOrderConfirmation, sendNewOrderToProducer, sendPasswordReset, isTestMode: () => isTestMode };
