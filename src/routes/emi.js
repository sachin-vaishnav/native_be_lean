const express = require('express');
const EMI = require('../models/EMI');
const Loan = require('../models/Loan');
const { protect } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/emi/pending
// @desc    Get all pending EMIs for user
// @access  Private
router.get('/pending', protect, async (req, res) => {
  try {
    const pendingEMIs = await EMI.find({
      userId: req.user._id,
      status: { $in: ['pending', 'overdue'] }
    })
    .populate('loanId', 'amount applicantName')
    .sort({ dueDate: 1 });
    
    res.json(pendingEMIs);
  } catch (error) {
    console.error('Pending EMIs error:', error);
    res.status(500).json({ message: 'Error fetching pending EMIs' });
  }
});

// @route   GET /api/emi/today
// @desc    Get today's EMIs for user
// @access  Private
router.get('/today', protect, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const todayEMIs = await EMI.find({
      userId: req.user._id,
      dueDate: { $gte: today, $lt: tomorrow }
    }).populate('loanId', 'amount applicantName');
    
    res.json(todayEMIs);
  } catch (error) {
    console.error('Today EMIs error:', error);
    res.status(500).json({ message: 'Error fetching today EMIs' });
  }
});

// @route   GET /api/emi/loan/:loanId
// @desc    Get all EMIs for a specific loan
// @access  Private
router.get('/loan/:loanId', protect, async (req, res) => {
  try {
    const loan = await Loan.findById(req.params.loanId);
    
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }
    
    // Check ownership
    if (loan.userId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const emis = await EMI.find({ loanId: req.params.loanId })
      .sort({ dayNumber: 1 });
    
    // Calculate summary
    const summary = {
      total: emis.length,
      paid: emis.filter(e => e.status === 'paid').length,
      pending: emis.filter(e => e.status === 'pending').length,
      overdue: emis.filter(e => e.status === 'overdue').length,
      totalPaid: emis.filter(e => e.status === 'paid').reduce((sum, e) => sum + e.totalAmount, 0),
      totalPending: emis.filter(e => e.status !== 'paid').reduce((sum, e) => sum + e.totalAmount, 0)
    };
    
    res.json({ emis, summary });
  } catch (error) {
    console.error('Loan EMIs error:', error);
    res.status(500).json({ message: 'Error fetching loan EMIs' });
  }
});

// @route   GET /api/emi/:id
// @desc    Get single EMI details
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const emi = await EMI.findById(req.params.id)
      .populate('loanId', 'amount applicantName status');
    
    if (!emi) {
      return res.status(404).json({ message: 'EMI not found' });
    }
    
    // Check ownership
    if (emi.userId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    res.json(emi);
  } catch (error) {
    console.error('Get EMI error:', error);
    res.status(500).json({ message: 'Error fetching EMI details' });
  }
});

module.exports = router;
