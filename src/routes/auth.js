const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const User = require('../models/User');

const router = express.Router();

// SMTP configuration (Brevo)
const hasSmtp = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
const smtpTransporter = hasSmtp ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 465, // Use 465 for SSL/TLS as 587 is often blocked on cloud platforms
  secure: true, // true for 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 10000
}) : null;

// Generate random 4-digit OTP
const generateOTP = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

// Generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

// Send OTP via SMTP (Brevo)
const sendOTPViaEmail = async (email, otp) => {
  if (!smtpTransporter) {
    console.log('SMTP not configured - Printing OTP:', otp);
    return;
  }

  try {
    const info = await smtpTransporter.sendMail({
      from: `"LoanSnap" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || 'no-reply@loansnap.com'}>`,
      to: email,
      subject: 'Your LoanSnap OTP',
      html: `<div style="font-family: sans-serif; padding: 20px;">
          <h2>Login OTP</h2>
          <p>Your OTP for LoanSnap is <strong>${otp}</strong>.</p>
          <p>This OTP is valid for 5 minutes.</p>
        </div>`
    });
    console.log('Message sent: %s', info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
};

// @route   POST /api/auth/send-otp
// @desc    Send OTP to email
// @access  Public
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !String(email).trim()) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailStr = String(email).trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailStr)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    let user = await User.findOne({ email: emailStr });

    if (!user) {
      user = new User({ email: emailStr });
    }

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    // Send OTP via SMTP (Brevo)
    if (hasSmtp) {
      await sendOTPViaEmail(emailStr, otp);
      res.json({ message: 'OTP sent to your email' });
    } else {
      console.log(`OTP for ${emailStr}: ${otp}`);
      res.json({ message: 'OTP sent (testing)', otp });
    }
  } catch (error) {
    console.error('Send OTP error:', error.message, error);
    res.status(500).json({ message: error.message || 'Error sending OTP' });
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP and login
// @access  Public
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (new Date() > user.otpExpiry) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    user.otp = null;
    user.otpExpiry = null;
    await user.save();

    const token = generateToken(user._id);
    const needsMobile = !user.mobile || !String(user.mobile).trim();

    res.json({
      message: 'Login successful',
      token,
      needsMobile,
      user: {
        id: user._id,
        email: user.email,
        mobile: user.mobile || '',
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ message: 'Error verifying OTP' });
  }
});

module.exports = router;
