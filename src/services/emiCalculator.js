const EMI = require('../models/EMI');
const Loan = require('../models/Loan');

/**
 * Generate EMI schedule for an approved loan
 * @param {Object} loan - The approved loan document
 * @returns {Array} Array of EMI documents
 */
const generateEMISchedule = async (loan) => {
  const emis = [];
  // Start from next day (not same day)
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 1);
  startDate.setHours(0, 0, 0, 0);
  
  const totalInterest = loan.amount * 0.20; // 20% of total amount
  const dailyPrincipal = Math.ceil(loan.amount / loan.totalDays);
  const dailyInterest = Math.ceil(totalInterest / loan.totalDays);
  
  for (let day = 1; day <= loan.totalDays; day++) {
    const dueDate = new Date(startDate);
    dueDate.setDate(startDate.getDate() + day - 1);
    
    const emi = new EMI({
      loanId: loan._id,
      userId: loan.userId,
      dayNumber: day,
      principalAmount: dailyPrincipal,
      interestAmount: dailyInterest,
      penaltyAmount: 0,
      totalAmount: dailyPrincipal + dailyInterest,
      dueDate: dueDate,
      status: 'pending'
    });
    
    emis.push(emi);
  }
  
  // Bulk insert EMIs
  await EMI.insertMany(emis);
  
  // Update loan start and end dates
  loan.startDate = startDate;
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + loan.totalDays - 1);
  loan.endDate = endDate;
  loan.approvedAt = new Date();
  await loan.save();
  
  return emis;
};

/**
 * Mark overdue EMIs and apply penalties
 * Run daily via cron at midnight; admin can also trigger via "Process Overdues" button
 */
const processOverdueEMIs = async () => {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  // Find all pending EMIs with due date before today
  const overdueEMIs = await EMI.find({
    status: 'pending',
    dueDate: { $lt: today }
  });
  
  for (const emi of overdueEMIs) {
    // Mark as overdue
    emi.status = 'overdue';
    
    // Add penalty: 120 per day late (base EMI = principal + interest, penalty = 120 per overdue day)
    const baseAmount = emi.principalAmount + emi.interestAmount;
    const daysOverdue = Math.floor((today - emi.dueDate) / (24 * 60 * 60 * 1000)) || 1;
    const penaltyPerDay = 120;
    emi.penaltyAmount = penaltyPerDay * daysOverdue;
    emi.totalAmount = baseAmount + emi.penaltyAmount;
    
    await emi.save();
    
    // Update loan penalty amount
    await Loan.findByIdAndUpdate(emi.loanId, {
      $inc: { penaltyAmount: emi.penaltyAmount }
    });
  }
  
  console.log(`Processed ${overdueEMIs.length} overdue EMIs`);
  return overdueEMIs.length;
};

/**
 * Calculate loan statistics
 * @param {String} loanId - Loan ID
 * @returns {Object} Loan statistics
 */
const getLoanStats = async (loanId) => {
  const emis = await EMI.find({ loanId });
  
  const stats = {
    totalEMIs: emis.length,
    paidEMIs: 0,
    pendingEMIs: 0,
    overdueEMIs: 0,
    totalPaid: 0,
    totalPending: 0,
    totalPenalty: 0
  };
  
  emis.forEach(emi => {
    if (emi.status === 'paid') {
      stats.paidEMIs++;
      stats.totalPaid += emi.totalAmount;
    } else if (emi.status === 'pending') {
      stats.pendingEMIs++;
      stats.totalPending += emi.totalAmount;
    } else if (emi.status === 'overdue') {
      stats.overdueEMIs++;
      stats.totalPending += emi.totalAmount;
      stats.totalPenalty += emi.penaltyAmount;
    }
  });
  
  return stats;
};

module.exports = {
  generateEMISchedule,
  processOverdueEMIs,
  getLoanStats
};
