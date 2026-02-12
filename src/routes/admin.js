const express = require('express');
const User = require('../models/User');
const Loan = require('../models/Loan');
const EMI = require('../models/EMI');
const Notification = require('../models/Notification');
const { getIO } = require('../socket');
const { protect, adminOnly } = require('../middleware/auth');
const { generateEMISchedule, getLoanStats, processOverdueEMIs } = require('../services/emiCalculator');
const { sendPushNotification } = require('../utils/pushNotifications');

const router = express.Router();

// Apply auth middleware to all admin routes
router.use(protect);
router.use(adminOnly);

// @route   POST /api/admin/users
// @desc    Create a new user or admin
// @access  Admin
router.post('/users', async (req, res) => {
  try {
    const { email, name, mobile, role } = req.body;

    if (!email || !String(email).trim()) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailStr = String(email).trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailStr)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const validRole = role === 'admin' ? 'admin' : 'user';
    const nameStr = String(name || '').trim();
    const mobileStr = String(mobile || '').trim().replace(/\D/g, '').slice(0, 10);

    const existing = await User.findOne({ email: emailStr });
    if (existing) {
      return res.status(400).json({ message: 'A user with this email already exists' });
    }

    const user = new User({
      email: emailStr,
      name: nameStr,
      mobile: mobileStr,
      role: validRole,
    });
    await user.save();

    const userObj = user.toObject();
    delete userObj.otp;
    delete userObj.otpExpiry;

    res.status(201).json({
      message: `${validRole === 'admin' ? 'Admin' : 'User'} created successfully`,
      user: userObj,
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ message: error.message || 'Error creating user' });
  }
});

// @route   GET /api/admin/users
// @desc    Get all users
// @access  Admin
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .select('-otp -otpExpiry')
      .sort({ createdAt: -1 });

    // Get loan count for each user
    const usersWithLoans = await Promise.all(users.map(async (user) => {
      const loanCount = await Loan.countDocuments({ userId: user._id });
      const activeLoans = await Loan.countDocuments({ userId: user._id, status: 'approved' });
      return {
        ...user.toObject(),
        loanCount,
        activeLoans
      };
    }));

    res.json(usersWithLoans);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
});

// @route   GET /api/admin/admins
// @desc    Get all admins
// @access  Admin
router.get('/admins', async (req, res) => {
  try {
    const admins = await User.find({ role: 'admin' })
      .select('-otp -otpExpiry')
      .sort({ createdAt: -1 });
    const adminsList = admins.map((a) => ({
      ...a.toObject(),
      loanCount: 0,
      activeLoans: 0,
    }));
    res.json(adminsList);
  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({ message: 'Error fetching admins' });
  }
});

// @route   GET /api/admin/users/:id
// @desc    Get user details with loans
// @access  Admin
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-otp -otpExpiry');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const loans = await Loan.find({ userId: user._id }).sort({ createdAt: -1 });

    // Get stats for each loan
    const loansWithStats = await Promise.all(loans.map(async (loan) => {
      if (loan.status === 'approved' || loan.status === 'completed') {
        const stats = await getLoanStats(loan._id);
        return { ...loan.toObject(), stats };
      }
      return loan.toObject();
    }));

    res.json({ user, loans: loansWithStats });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ message: 'Error fetching user details' });
  }
});

// @route   GET /api/admin/loans/pending
// @desc    Get all pending loan applications
// @access  Admin
router.get('/loans/pending', async (req, res) => {
  try {
    const pendingLoans = await Loan.find({ status: 'pending' })
      .populate('userId', 'email mobile name')
      .sort({ createdAt: -1 });

    res.json(pendingLoans);
  } catch (error) {
    console.error('Pending loans error:', error);
    res.status(500).json({ message: 'Error fetching pending loans' });
  }
});

// @route   PUT /api/admin/loans/:id/approve
// @desc    Approve a loan application (admin can change amount and totalDays)
// @access  Admin
router.put('/loans/:id/approve', async (req, res) => {
  try {
    const { amount, totalDays } = req.body;
    const loan = await Loan.findById(req.params.id);

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    if (loan.status !== 'pending') {
      return res.status(400).json({ message: 'Loan is not in pending status' });
    }

    // Admin can change amount (1000 - 100000)
    if (amount != null) {
      const amt = parseInt(amount);
      if (isNaN(amt) || amt < 1000 || amt > 100000) {
        return res.status(400).json({ message: 'Amount must be between ₹1,000 and ₹1,00,000' });
      }
      loan.amount = amt;
    }

    // Admin can change total days (1 - 365)
    if (totalDays != null) {
      const days = parseInt(totalDays);
      if (isNaN(days) || days < 1 || days > 365) {
        return res.status(400).json({ message: 'Total days must be between 1 and 365' });
      }
      loan.totalDays = days;
    }

    loan.status = 'approved';
    loan.interestRate = 20; // Fixed 20% interest

    // Generate EMI schedule (starts next day)
    await generateEMISchedule(loan);

    const notif = await Notification.create({
      type: 'loan_approved',
      forAdmin: false,
      userId: loan.userId,
      loanId: loan._id,
      title: 'Loan Approved',
      body: `Your loan of ₹${loan.amount.toLocaleString('en-IN')} has been approved.`,
    });
    const io = getIO();
    if (io) io.to(`user:${loan.userId}`).emit('notification', notif.toObject());

    // Send push notification to the user
    try {
      const user = await User.findById(loan.userId).select('pushToken');
      if (user && user.pushToken) {
        await sendPushNotification(
          user.pushToken,
          'Loan Approved',
          `Your loan of ₹${loan.amount.toLocaleString('en-IN')} has been approved!`,
          { loanId: loan._id, type: 'loan_approved' }
        );
      }
    } catch (pushErr) {
      console.error('Push notification error:', pushErr);
    }
    res.json({
      message: 'Loan approved successfully',
      loan
    });
  } catch (error) {
    console.error('Approve loan error:', error);
    res.status(500).json({ message: 'Error approving loan' });
  }
});

// @route   PUT /api/admin/loans/:id/reject
// @desc    Reject a loan application
// @access  Admin
router.put('/loans/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;

    const loan = await Loan.findById(req.params.id);

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    if (loan.status !== 'pending') {
      return res.status(400).json({ message: 'Loan is not in pending status' });
    }

    loan.status = 'rejected';
    await loan.save();

    res.json({
      message: 'Loan rejected',
      loan
    });
  } catch (error) {
    console.error('Reject loan error:', error);
    res.status(500).json({ message: 'Error rejecting loan' });
  }
});

// @route   POST /api/admin/process-overdues
// @desc    Admin manually processes overdue EMIs (marks overdue + applies penalty)
// @access  Admin
router.post('/process-overdues', async (req, res) => {
  try {
    const count = await processOverdueEMIs();
    res.json({ message: `Processed ${count} overdue EMI(s)`, count });
  } catch (error) {
    console.error('Process overdues error:', error);
    res.status(500).json({ message: 'Error processing overdues' });
  }
});

// @route   GET /api/admin/emis/today
// @desc    Get today's EMIs for all users
// @access  Admin
router.get('/emis/today', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayEMIs = await EMI.find({
      dueDate: { $gte: today, $lt: tomorrow }
    })
      .populate('userId', 'email mobile name')
      .populate('loanId', 'amount applicantName')
      .sort({ status: -1 }); // Overdue first, then pending, then paid

    // Calculate summary
    const summary = {
      total: todayEMIs.length,
      paid: todayEMIs.filter(e => e.status === 'paid').length,
      pending: todayEMIs.filter(e => e.status === 'pending').length,
      overdue: todayEMIs.filter(e => e.status === 'overdue').length,
      totalAmount: todayEMIs.reduce((sum, e) => sum + e.totalAmount, 0),
      collectedAmount: todayEMIs.filter(e => e.status === 'paid').reduce((sum, e) => sum + e.totalAmount, 0)
    };

    res.json({ emis: todayEMIs, summary });
  } catch (error) {
    console.error('Today EMIs error:', error);
    res.status(500).json({ message: 'Error fetching today EMIs' });
  }
});

// @route   GET /api/admin/emis/total
// @desc    Get total EMI statistics
// @access  Admin
router.get('/emis/total', async (req, res) => {
  try {
    const allEMIs = await EMI.find();

    const stats = {
      totalEMIs: allEMIs.length,
      paidEMIs: allEMIs.filter(e => e.status === 'paid').length,
      pendingEMIs: allEMIs.filter(e => e.status === 'pending').length,
      overdueEMIs: allEMIs.filter(e => e.status === 'overdue').length,
      totalAmount: allEMIs.reduce((sum, e) => sum + e.totalAmount, 0),
      collectedAmount: allEMIs.filter(e => e.status === 'paid').reduce((sum, e) => sum + e.totalAmount, 0),
      pendingAmount: allEMIs.filter(e => e.status !== 'paid').reduce((sum, e) => sum + e.totalAmount, 0),
      totalPenalty: allEMIs.reduce((sum, e) => sum + (e.penaltyAmount || 0), 0)
    };

    // Get loan stats
    const loans = await Loan.find();
    stats.totalLoans = loans.length;
    stats.approvedLoans = loans.filter(l => l.status === 'approved').length;
    stats.pendingLoans = loans.filter(l => l.status === 'pending').length;
    stats.totalDisbursed = loans.filter(l => l.status === 'approved' || l.status === 'completed')
      .reduce((sum, l) => sum + l.amount, 0);

    res.json(stats);
  } catch (error) {
    console.error('Total EMIs error:', error);
    res.status(500).json({ message: 'Error fetching EMI statistics' });
  }
});

// @route   PUT /api/admin/emis/:id/mark-paid
// @desc    Admin marks EMI as paid
// @access  Admin
router.put('/emis/:id/mark-paid', async (req, res) => {
  try {
    const emi = await EMI.findById(req.params.id);
    if (!emi) return res.status(404).json({ message: 'EMI not found' });
    if (emi.status === 'paid') return res.status(400).json({ message: 'EMI already paid' });

    emi.status = 'paid';
    emi.paidAt = new Date();
    emi.razorpayPaymentId = `admin_${req.user._id}_${Date.now()}`;
    await emi.save();

    const loan = await Loan.findById(emi.loanId);
    if (loan) {
      loan.totalPaid += emi.totalAmount;
      loan.remainingBalance -= (emi.principalAmount + emi.interestAmount);
      const pendingCount = await EMI.countDocuments({ loanId: loan._id, status: { $ne: 'paid' } });
      if (pendingCount === 0) loan.status = 'completed';
      await loan.save();
    }

    const notif = await Notification.create({
      type: 'emi_paid',
      forAdmin: true,
      userId: emi.userId,
      loanId: emi.loanId,
      emiId: emi._id,
      title: 'EMI Marked Paid (Admin)',
      body: `EMI Day ${emi.dayNumber} - ₹${emi.totalAmount} marked paid.`,
    });
    const io = getIO();
    if (io) io.to('admin').emit('notification', notif.toObject());
    res.json({ message: 'EMI marked as paid', emi });
  } catch (error) {
    console.error('Mark paid error:', error);
    res.status(500).json({ message: 'Error marking EMI as paid' });
  }
});

// @route   DELETE /api/admin/loans/:id
// @desc    Delete a loan (with confirmation - caller must confirm)
// @access  Admin
router.delete('/loans/:id', async (req, res) => {
  try {
    const loan = await Loan.findById(req.params.id);
    if (!loan) return res.status(404).json({ message: 'Loan not found' });

    await EMI.deleteMany({ loanId: loan._id });
    await Loan.findByIdAndDelete(loan._id);

    res.json({ message: 'Loan deleted successfully' });
  } catch (error) {
    console.error('Delete loan error:', error);
    res.status(500).json({ message: 'Error deleting loan' });
  }
});

// @route   GET /api/admin/dashboard
// @desc    Get admin dashboard summary
// @access  Admin
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Count stats
    const totalUsers = await User.countDocuments({ role: 'user' });
    const pendingLoans = await Loan.countDocuments({ status: 'pending' });
    const activeLoans = await Loan.countDocuments({ status: 'approved' });

    const todayEMIs = await EMI.countDocuments({
      dueDate: { $gte: today, $lt: tomorrow }
    });

    const todayPendingEMIs = await EMI.countDocuments({
      dueDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['pending', 'overdue'] }
    });

    const overdueEMIs = await EMI.countDocuments({ status: 'overdue' });

    // Get recent loan applications
    const recentApplications = await Loan.find({ status: 'pending' })
      .populate('userId', 'email mobile name')
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      stats: {
        totalUsers,
        pendingLoans,
        activeLoans,
        todayEMIs,
        todayPendingEMIs,
        overdueEMIs
      },
      recentApplications
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ message: 'Error fetching dashboard' });
  }
});

module.exports = router;
