import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';
import { calcFeeDistribution, calculateFee } from '../utils/common.js';
import { DEFAULT, MAX_TOTAL_FEES } from '../utils/defaults.js';
import { createDeployer, type EthosDeployer } from '../utils/deployEthos.js';
import { type EthosUser } from '../utils/ethosUser.js';

const { ethers, network } = hre;

const paymentAmount = DEFAULT.PAYMENT_AMOUNT;

const entryFee = 50n;
const exitFee = 100n;
const donationFee = 150n;
const vouchIncentives = 200n;

const feeConfig = {
  entry: async (deployer: EthosDeployer) => {
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryProtocolFeeBasisPoints(entryFee);
  },
  exit: async (deployer: EthosDeployer) => {
    await deployer.ethosVouch.contract.connect(deployer.ADMIN).setExitFeeBasisPoints(exitFee);
  },
  donation: async (deployer: EthosDeployer) => {
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryDonationFeeBasisPoints(donationFee);
  },
  vouchIncentives: async (deployer: EthosDeployer) => {
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryVouchersPoolFeeBasisPoints(vouchIncentives);
  },
};

async function setupFees(deployer: EthosDeployer): Promise<void> {
  await Promise.all(
    Object.values(feeConfig).map(async (fee) => {
      await fee(deployer);
    }),
  );
}

describe('Vouch Fees', () => {
  let deployer: EthosDeployer;
  let userA: EthosUser;
  let userB: EthosUser;

  beforeEach(async () => {
    deployer = await loadFixture(createDeployer);
    [userA, userB] = await Promise.all([deployer.createUser(), deployer.createUser()]);
  });

  it('should apply a protocol fee on vouch entry', async () => {
    await feeConfig.entry(deployer);
    const { vouchId } = await userA.vouch(userB);
    const balance = await userA.getVouchBalance(vouchId);
    const expected = calculateFee(paymentAmount, entryFee).deposit;
    expect(balance).to.equal(expected);
  });

  it('should apply a exit protocol fee on unvouch', async () => {
    await feeConfig.exit(deployer);
    const fee = await deployer.ethosVouch.contract.exitFeeBasisPoints();
    expect(fee).to.equal(exitFee);
    const { vouchId } = await userA.vouch(userB);
    const vouchBalance = await userA.getVouchBalance(vouchId);
    const balanceBeforeUnvouch = await userA.getBalance();
    const unvouchTx = await userA.unvouch(vouchId);
    const receipt = await unvouchTx.wait();

    if (!receipt) {
      expect.fail('Transaction failed or receipt is null');
    }

    const transactionFee = receipt.gasUsed * receipt.gasPrice; // transactionFee means network fee not the protocol fees
    const balanceAfterUnvouch = await userA.getBalance();
    const balanceDifference = balanceAfterUnvouch - balanceBeforeUnvouch + transactionFee;
    const actualFeesPaid = vouchBalance - balanceDifference;
    const expectedFeesPaid = calculateFee(paymentAmount, exitFee).fee;
    expect(actualFeesPaid).to.equal(expectedFeesPaid);
  });

  it('should apply a donation to the vouch recipient on vouch entry', async () => {
    await feeConfig.donation(deployer);
    const { vouchId } = await userA.vouch(userB);
    const balance = {
      userA: await userA.getVouchBalance(vouchId),
      userB: await userB.getRewardsBalance(),
    };
    const expected = {
      userA: calculateFee(paymentAmount, donationFee).deposit,
      userB: calculateFee(paymentAmount, donationFee).fee,
    };
    expect(balance).to.deep.equal(expected);
  });

  it('should apply all fees', async () => {
    await setupFees(deployer);

    // Calculate fees for initial vouch
    const { deposit: initialDeposit } = calcFeeDistribution(paymentAmount, {
      entry: entryFee,
      donation: donationFee,
      vouchIncentives: 0n,
    });

    const { vouchId } = await userA.vouch(userB);
    const balance = await userA.getVouchBalance(vouchId);
    expect(balance).to.be.closeTo(initialDeposit, 2n);
    const balanceBeforeUnvouch = await userA.getBalance();
    const unvouchTx = await userA.unvouch(vouchId);
    const receipt = await unvouchTx.wait();

    if (!receipt) {
      expect.fail('Transaction failed or receipt is null');
    }

    const transactionFee = receipt.gasUsed * receipt.gasPrice;
    const balanceAfterUnvouch = await userA.getBalance();
    const amountReceived = balanceAfterUnvouch - balanceBeforeUnvouch + transactionFee;

    // Calculate exit fee on the vouch balance
    const { deposit: expectedAfterExit } = calculateFee(balance, exitFee);
    expect(amountReceived).to.be.closeTo(expectedAfterExit, 1n);
  });

  it('should allow changing the entry fee basis points', async () => {
    const newEntryFee = 75n;

    // Set initial entry fee
    await feeConfig.entry(deployer);

    // Change entry fee
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryProtocolFeeBasisPoints(newEntryFee);

    // Verify the new fee is applied
    const { vouchId } = await userA.vouch(userB);
    const balance = await userA.getVouchBalance(vouchId);
    const expected = calculateFee(paymentAmount, newEntryFee).deposit;

    expect(balance).to.equal(expected);
  });

  it('should allow changing the exit fee basis points', async () => {
    const newExitFee = 150n;

    // Set initial exit fee
    await feeConfig.exit(deployer);

    // Create initial vouch
    const { vouchId } = await userA.vouch(userB);

    // Change exit fee
    await deployer.ethosVouch.contract.connect(deployer.ADMIN).setExitFeeBasisPoints(newExitFee);

    // Unvouch and verify the new fee is applied
    const balanceBeforeUnvouch = await userA.getBalance();
    const unvouchTx = await userA.unvouch(vouchId);
    const receipt = await unvouchTx.wait();

    if (!receipt) {
      expect.fail('Transaction failed or receipt is null');
    }

    const transactionFee = receipt.gasUsed * receipt.gasPrice; // transactionFee means network fee not the protocol fees
    const balanceAfterUnvouch = await userA.getBalance();
    // Calculate the actual amount received by the user
    const amountReceivedByUser = balanceAfterUnvouch - balanceBeforeUnvouch + transactionFee;
    // Calculate the expected amount after fee deduction
    const expectedAmountAfterFee = calculateFee(paymentAmount, newExitFee).deposit;
    // The difference should be very small (to account for potential rounding errors)
    expect(amountReceivedByUser).to.be.closeTo(expectedAmountAfterFee, 1n);
  });

  it('should allow changing the fee recipient address', async () => {
    const newFeeRecipient = await deployer.newWallet();

    // Get the current fee recipient
    const currentFeeRecipient = await deployer.ethosVouch.contract.protocolFeeAddress();

    // Change the fee recipient
    await deployer.ethosVouch.contract
      .connect(deployer.OWNER)
      .setProtocolFeeAddress(newFeeRecipient.address);

    // Get the updated fee recipient
    const updatedFeeRecipient = await deployer.ethosVouch.contract.protocolFeeAddress();

    // Check that the fee recipient has been updated
    expect(updatedFeeRecipient).to.not.equal(currentFeeRecipient);
    expect(updatedFeeRecipient).to.equal(newFeeRecipient.address);
  });

  it('should not allow setting entry protocol fee that exceeds maximum total fees', async () => {
    const currentTotalFees = await getTotalFees();
    const invalidEntryFee = MAX_TOTAL_FEES - currentTotalFees + 1n;

    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryProtocolFeeBasisPoints(invalidEntryFee),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'FeesExceedMaximum');
  });

  it('should not allow setting exit fee that exceeds maximum total fees', async () => {
    const currentTotalFees = await getTotalFees();
    const invalidExitFee = MAX_TOTAL_FEES - currentTotalFees + 1n;

    await expect(
      deployer.ethosVouch.contract.connect(deployer.ADMIN).setExitFeeBasisPoints(invalidExitFee),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'FeesExceedMaximum');
  });

  it('should not allow setting donation fee that exceeds maximum total fees', async () => {
    const currentTotalFees = await getTotalFees();
    const invalidDonationFee = MAX_TOTAL_FEES - currentTotalFees + 1n;

    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryDonationFeeBasisPoints(invalidDonationFee),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'FeesExceedMaximum');
  });

  it('should not allow setting vouchers pool fee that exceeds maximum total fees', async () => {
    const currentTotalFees = await getTotalFees();
    const invalidVouchersPoolFee = MAX_TOTAL_FEES - currentTotalFees + 1n;

    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryVouchersPoolFeeBasisPoints(invalidVouchersPoolFee),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'FeesExceedMaximum');
  });

  it('should allow setting fees up to the maximum total', async () => {
    const quarterMaxFee = MAX_TOTAL_FEES / 4n;

    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryProtocolFeeBasisPoints(quarterMaxFee),
    ).to.not.be.reverted;

    await expect(
      deployer.ethosVouch.contract.connect(deployer.ADMIN).setExitFeeBasisPoints(quarterMaxFee),
    ).to.not.be.reverted;

    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryDonationFeeBasisPoints(quarterMaxFee),
    ).to.not.be.reverted;

    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryVouchersPoolFeeBasisPoints(quarterMaxFee),
    ).to.not.be.reverted;
  });

  it('should allow withdrawing accumulated rewards', async () => {
    await feeConfig.donation(deployer);

    // Create a vouch to generate rewards for userB`
    await userA.vouch(userB);
    const initialBalance = await userB.getBalance();

    // Get rewards balance
    const rewardsBalance = await userB.getRewardsBalance();
    expect(rewardsBalance).to.equal(calculateFee(paymentAmount, donationFee).fee);

    // Withdraw rewards
    const withdrawTx = await deployer.ethosVouch.contract.connect(userB.signer).claimRewards();
    const receipt = await withdrawTx.wait();

    if (!receipt) {
      expect.fail('Transaction failed or receipt is null');
    }

    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const finalBalance = await userB.getBalance();

    // Verify the balance increased by rewards amount (minus gas costs)
    const expectedBalance = initialBalance + rewardsBalance - gasCost;
    expect(finalBalance).to.equal(expectedBalance);

    // Verify rewards balance is now 0
    const newRewardsBalance = await userB.getRewardsBalance();
    expect(newRewardsBalance).to.equal(0n);
  });

  it('should revert when protocol fee transfer fails', async () => {
    // Set protocol fee address to rejecting contract
    await deployer.ethosVouch.contract
      .connect(deployer.OWNER)
      .setProtocolFeeAddress(deployer.rejectETHReceiver.address);

    // Set up fees
    await feeConfig.entry(deployer);

    // Attempt vouch which should fail due to protocol fee transfer
    await expect(userA.vouch(userB))
      .to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'FeeTransferFailed')
      .withArgs('Protocol fee deposit failed');
  });

  it('should revert when rewards withdrawal transfer fails', async () => {
    await feeConfig.donation(deployer);

    // Generate rewards
    await userA.vouch(userB);

    // Register the rejecting contract as a valid address for userB's profile
    await userB.registerAddress(deployer.rejectETHReceiver.address);

    // Create a new signer with the rejecting contract address
    const rejectingSigner = await ethers.getImpersonatedSigner(deployer.rejectETHReceiver.address);

    // Fund the rejecting signer with ETH for gas using setBalance instead of transfer
    await network.provider.send('hardhat_setBalance', [
      deployer.rejectETHReceiver.address,
      ethers.toBeHex(ethers.parseEther('1.0')),
    ]);

    // Attempt withdrawal from the rejecting contract address
    await expect(deployer.ethosVouch.contract.connect(rejectingSigner).claimRewards())
      .to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'FeeTransferFailed')
      .withArgs('Rewards claim failed');

    // Clean up: Register back the original address
    await userB.registerAddress(await userB.signer.getAddress());
  });

  it('should revert when initializing with zero protocol fee address', async () => {
    const EthosVouch = await ethers.getContractFactory('EthosVouch');
    const vouchImplementation = await EthosVouch.deploy();
    const proxy = await ethers.getContractFactory('ERC1967Proxy');

    await expect(
      proxy.deploy(
        await vouchImplementation.getAddress(),
        EthosVouch.interface.encodeFunctionData('initialize', [
          deployer.OWNER.address,
          deployer.ADMIN.address,
          deployer.EXPECTED_SIGNER.address,
          deployer.signatureVerifier.address,
          deployer.contractAddressManager.address,
          ethers.ZeroAddress, // Invalid zero address for protocol fee
          0n, // entryProtocolFeeBasisPoints
          0n, // entryDonationFeeBasisPoints
          0n, // entryVouchersPoolFeeBasisPoints
          0n, // exitFeeBasisPoints
        ]),
      ),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'InvalidFeeProtocolAddress');
  });

  it('should authorize upgrade only by owner', async () => {
    const EthosVouch = await ethers.getContractFactory('EthosVouch');
    const newImplementation = await EthosVouch.deploy();

    // Should revert when non-owner tries to upgrade
    await expect(
      deployer.ethosVouch.contract
        .connect(userA.signer)
        .upgradeToAndCall(await newImplementation.getAddress(), '0x'),
    )
      .to.be.revertedWithCustomError(
        deployer.ethosVouch.contract,
        'AccessControlUnauthorizedAccount',
      )
      .withArgs(await userA.signer.getAddress(), await deployer.ethosVouch.contract.OWNER_ROLE());

    // Should succeed when owner upgrades
    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.OWNER)
        .upgradeToAndCall(await newImplementation.getAddress(), '0x'),
    ).to.not.be.reverted;
  });

  it('should not allow upgrade to zero address', async () => {
    await expect(
      deployer.ethosVouch.contract
        .connect(deployer.OWNER)
        .upgradeToAndCall(ethers.ZeroAddress, '0x'),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'ZeroAddress');
  });

  it('should handle vouchers pool fees correctly for first and subsequent vouches', async () => {
    // Set up fees
    const protocolFee = 400n; // 4%
    const donationFee = 300n; // 3%
    const vouchersPoolFee = 200n; // 2%

    await Promise.all([
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryProtocolFeeBasisPoints(protocolFee),
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryDonationFeeBasisPoints(donationFee),
      deployer.ethosVouch.contract
        .connect(deployer.ADMIN)
        .setEntryVouchersPoolFeeBasisPoints(vouchersPoolFee),
    ]);

    const vouchAmount = ethers.parseEther('1.0');
    const BASIS_POINTS = 10000n;

    // Set high balances to avoid insufficient funds
    await userA.setBalance(ethers.parseEther('1000.0').toString());
    await userB.setBalance(ethers.parseEther('1000.0').toString());

    // Calculate total fees first
    const firstVouchFeeBasisPoints = donationFee + protocolFee;
    const firstVouchFees =
      vouchAmount - (vouchAmount * BASIS_POINTS) / (BASIS_POINTS + firstVouchFeeBasisPoints);

    // Calculate individual fee shares
    const firstVouchDonationShare = (firstVouchFees * donationFee) / firstVouchFeeBasisPoints;

    // Track initial rewards
    const initialUserBRewards = await userB.getRewardsBalance();

    // Make first vouch
    const { vouchId: firstVouchId } = await userA.vouch(userB, { paymentAmount: vouchAmount });

    // Check rewards after first vouch
    const afterFirstVouchRewards = await userB.getRewardsBalance();
    const rewardsIncrease = afterFirstVouchRewards - initialUserBRewards;

    // For first vouch, only donation fee goes to rewards
    expect(rewardsIncrease).to.be.closeTo(firstVouchDonationShare, 1n);

    // Second vouch
    const userC = await deployer.createUser();
    await userC.setBalance(ethers.parseEther('1000.0').toString());
    const secondVouchBasisPoints = donationFee + protocolFee + vouchersPoolFee;
    const secondVouchFees =
      vouchAmount - (vouchAmount * BASIS_POINTS) / (BASIS_POINTS + secondVouchBasisPoints);
    const secondVouchVouchersPoolShare =
      (secondVouchFees * vouchersPoolFee) / secondVouchBasisPoints;

    // Track first voucher's balance before second vouch
    const beforeSecondVouchBalance = await userA.getVouchBalance(firstVouchId);

    // Make second vouch
    const { vouchId: secondVouchId } = await userC.vouch(userB, { paymentAmount: vouchAmount });
    const secondVouchBalance = await userA.getVouchBalance(secondVouchId);

    // Check first voucher's balance after second vouch
    const afterSecondVouchBalance = await userA.getVouchBalance(firstVouchId);
    const voucherBalanceIncrease = afterSecondVouchBalance - beforeSecondVouchBalance;

    // Third vouch
    const userD = await deployer.createUser();
    await userD.setBalance(ethers.parseEther('1000.0').toString());
    const { vouchId: thirdVouchId } = await userD.vouch(userB, { paymentAmount: vouchAmount });
    const thirdVouchBalance = await userA.getVouchBalance(thirdVouchId);

    // First voucher should receive the vouchers pool fee from second vouch (allow 1 wei difference)
    expect(voucherBalanceIncrease).to.be.closeTo(secondVouchVouchersPoolShare, 1n);
    // First vouch balance should be greater than second vouch balance
    expect(beforeSecondVouchBalance).to.gt(secondVouchBalance);
    // All the consequent vouches should have the same balance
    expect(secondVouchBalance).to.equal(thirdVouchBalance);
  });

  it('should limit voucher rewards to their vouch amount when they are the only voucher', async () => {
    // Set up a scenario where vouchers pool fee is high
    const vouchersPoolFee = 1000n; // 10% - maximum allowed fee
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryVouchersPoolFeeBasisPoints(vouchersPoolFee);

    // First vouch - small amount
    const smallVouchAmount = paymentAmount; // Use default payment amount
    await userA.setBalance((paymentAmount * 10n).toString());
    const { vouchId: firstVouchId } = await userA.vouch(userB, { paymentAmount: smallVouchAmount });

    // Second vouch - large amount (100x first vouch)
    const largeVouchAmount = paymentAmount * 1000n;
    const userC = await deployer.createUser();
    await userC.setBalance((largeVouchAmount * 2n).toString());

    // Get userA's vouch balance before second vouch
    const balanceBeforeSecondVouch = await userA.getVouchBalance(firstVouchId);

    // Make second vouch
    await userC.vouch(userB, { paymentAmount: largeVouchAmount });

    // Get userA's vouch balance after second vouch
    const balanceAfterSecondVouch = await userA.getVouchBalance(firstVouchId);
    const rewardAmount = balanceAfterSecondVouch - balanceBeforeSecondVouch;

    // The reward should not exceed the original vouch amount
    expect(rewardAmount).to.be.lte(smallVouchAmount);
  });

  it('should limit voucher rewards when there are multiple eligible vouchers', async () => {
    // Set up a scenario where vouchers pool fee is high
    const vouchersPoolFee = 1000n; // 10% - maximum allowed fee
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryVouchersPoolFeeBasisPoints(vouchersPoolFee);

    // Third vouch - large amount (1000x initial vouch)
    const largeVouchAmount = paymentAmount * 1000n;
    const userD = await deployer.createUser();

    // First two vouches - equal amounts
    const initialVouchAmount = paymentAmount;
    await Promise.all([
      userA.setBalance((paymentAmount * 20n).toString()),
      userB.setBalance((paymentAmount * 20n).toString()),
      userD.setBalance((largeVouchAmount * 20n).toString()),
    ]);

    const userC = await deployer.createUser();
    const { vouchId: firstVouchId } = await userA.vouch(userC, {
      paymentAmount: initialVouchAmount,
    });
    const { vouchId: secondVouchId } = await userB.vouch(userC, {
      paymentAmount: initialVouchAmount,
    });

    // Get balances before third vouch
    const [firstVoucherInitialBalance, secondVoucherInitialBalance] = await Promise.all([
      userA.getVouchBalance(firstVouchId),
      userB.getVouchBalance(secondVouchId),
    ]);

    // Make third vouch
    await userD.vouch(userC, { paymentAmount: largeVouchAmount });

    // Get balances after third vouch
    const [firstVoucherFinalBalance, secondVoucherFinalBalance] = await Promise.all([
      userA.getVouchBalance(firstVouchId),
      userB.getVouchBalance(secondVouchId),
    ]);

    // Calculate rewards for each voucher explicitly
    const rewardsForFirstVoucher = firstVoucherFinalBalance - firstVoucherInitialBalance;
    const rewardsForSecondVoucher = secondVoucherFinalBalance - secondVoucherInitialBalance;
    // The rewards don't exceed the original vouch amount since there are multiple vouchers
    expect(rewardsForFirstVoucher).to.be.lte(
      firstVoucherInitialBalance,
      'Rewards for first voucher should be less than or equal to the vouch amount',
    );
    expect(rewardsForSecondVoucher).to.be.lte(
      firstVoucherInitialBalance,
      'Rewards for second voucher should be less than or equal to the vouch amount',
    );
  });

  it('should not deduct vouchers pool fee when there are no previous vouchers', async () => {
    // Set up fees - only vouchers pool fee
    const vouchersPoolFee = 500n; // 5%
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryVouchersPoolFeeBasisPoints(vouchersPoolFee);

    // Clear other fees to isolate the issue
    await Promise.all([
      deployer.ethosVouch.contract.connect(deployer.ADMIN).setEntryProtocolFeeBasisPoints(0n),
      deployer.ethosVouch.contract.connect(deployer.ADMIN).setEntryDonationFeeBasisPoints(0n),
    ]);

    const vouchAmount = ethers.parseEther('1.0');
    // Convert to string without decimal points
    await userA.setBalance(vouchAmount.toString());

    // First vouch - should not deduct vouchers pool fee since there are no previous vouchers
    const initialBalance = await userA.getBalance();
    const vouchTx = await userA.deployer.ethosVouch.contract
      .connect(userA.signer)
      .vouchByProfileId(userB.profileId, DEFAULT.COMMENT, DEFAULT.METADATA, { value: vouchAmount });
    const receipt = await vouchTx.wait();

    if (!receipt) {
      expect.fail('Transaction receipt not found');
    }

    // Get transaction cost
    const gasCost = receipt.gasUsed * receipt.gasPrice;

    // Get the vouch details
    const vouch = await userA.deployer.ethosVouch.contract.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    // Check vouch balance
    const vouchBalance = await userA.getVouchBalance(vouch.vouchId);

    // Expected: full amount minus gas (no fees since there were no previous vouchers)
    expect(vouchBalance).to.equal(vouchAmount, 'Vouch balance should be the full amount');

    // Verify user's ETH balance reflects this
    const finalBalance = await userA.getBalance();
    const expectedFinalBalance = initialBalance - vouchAmount - gasCost;
    expect(finalBalance).to.equal(expectedFinalBalance, 'User balance should reflect the vouch');
  });

  it('should correctly calculate all fees for initial vouch of 1 ETH times total fee percentage', async () => {
    // Set up all fees
    await setupFees(deployer);

    // Calculate total amount needed using basis points (10000 = 100%)
    const BASIS_POINTS = 10000n;
    const totalFeeBasisPoints = entryFee + donationFee; // omit vouchIncentives because there's no previous vouchers
    const oneEth = ethers.parseEther('1.0');
    const vouchAmount = (oneEth * (BASIS_POINTS + totalFeeBasisPoints)) / BASIS_POINTS;

    await userA.setBalance((vouchAmount * 2n).toString());
    const protocolBalance = await ethers.provider.getBalance(
      await deployer.ethosVouch.contract.protocolFeeAddress(),
    );

    // Calculate expected fee distribution
    const { deposit: expectedDeposit, shares } = calcFeeDistribution(vouchAmount, {
      entry: entryFee,
      donation: donationFee,
      vouchIncentives: 0n,
    });
    expect(expectedDeposit).to.equal(oneEth, 'Expected deposit should be 1 ETH');

    // Get initial balances
    const initialProtocolBalance = await ethers.provider.getBalance(
      await deployer.ethosVouch.contract.protocolFeeAddress(),
    );
    const initialRecipientRewards = await userB.getRewardsBalance();

    // Perform vouch
    const { vouchId } = await userA.vouch(userB, { paymentAmount: vouchAmount });

    // Get final balances
    const [vouchBalance, recipientRewards, protocolFeeBalance] = await Promise.all([
      userA.getVouchBalance(vouchId),
      userB.getRewardsBalance(),
      ethers.provider.getBalance(await deployer.ethosVouch.contract.protocolFeeAddress()),
    ]);

    // Calculate actual fees paid
    const actualProtocolFee = protocolFeeBalance - initialProtocolBalance;
    const actualDonationFee = recipientRewards - initialRecipientRewards;
    expect(actualProtocolFee).to.equal(shares.protocol, 'Protocol fee matches calculation');
    expect(actualDonationFee).to.equal(shares.donation, 'Donation fee matches calculation');

    // Vouch balance should be deposit amount (no vouchers pool fee since it's first vouch)
    expect(vouchBalance).to.equal(oneEth, 'Vouch balance should be 1 ETH');

    // Recipient should receive donation fee
    expect(recipientRewards).to.equal(shares.donation, 'Recipient rewards should be donation fee');

    // Protocol fee address should receive protocol fee
    expect(protocolFeeBalance - protocolBalance).to.equal(
      shares.protocol,
      'Protocol fee matches calculation',
    );
  });

  async function getTotalFees(): Promise<bigint> {
    const [entryFee, exitFee, donationFee, vouchersPoolFee] = await Promise.all([
      deployer.ethosVouch.contract.entryProtocolFeeBasisPoints(),
      deployer.ethosVouch.contract.exitFeeBasisPoints(),
      deployer.ethosVouch.contract.entryDonationFeeBasisPoints(),
      deployer.ethosVouch.contract.entryVouchersPoolFeeBasisPoints(),
    ]);

    return entryFee + exitFee + donationFee + vouchersPoolFee;
  }
});
