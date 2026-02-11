const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const User = require('../models/User');

const router = express.Router();
const apiKey = process.env.RESEND_API_KEY ?? '';
const resend = apiKey ? new Resend(apiKey) : null;

// SMTP configuration
const hasSmtp = process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD;
const smtpTransporter = hasSmtp ? nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD
  }
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

// Send OTP via Resend (works on Railway - SMTP is often blocked)
const sendOTPViaEmail = async (email, otp) => {
  if (!resend) throw new Error('RESEND_API_KEY not configured');

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM || 'Loan App <onboarding@resend.dev>',
    to: [email],
    subject: 'Your Loan App OTP',
    html: `<p>Your OTP for Loan App login is <strong>${otp}</strong>.</p><p>Valid for 5 minutes.</p>`
  });

  if (error) throw new Error(error.message);
};

// Send OTP via SMTP (Gmail)
const sendOTPViaSMTP = async (email, otp) => {
  if (!smtpTransporter) throw new Error('SMTP not configured');

  await smtpTransporter.sendMail({
    from: process.env.SMTP_EMAIL,
    to: email,
    subject: 'Your Loan App OTP',
    html: `<p>Your OTP for Loan App login is <strong>${otp}</strong>.</p><p>Valid for 5 minutes.</p>`
  });
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

    // Resend works on Render (SMTP ports are blocked on most cloud platforms)
    if (resend) {
      await sendOTPViaEmail(emailStr, otp);
      res.json({ message: 'OTP sent to your email' });
    } else if (hasSmtp) {
      await sendOTPViaSMTP(emailStr, otp);
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
